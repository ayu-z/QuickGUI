//! Bounded SQLite history. Call from a background persistence worker, never
//! perform disk I/O directly inside the engine's synchronous observer callback.
mod range;
use crate::{now_ms, Project, RuntimeSnapshot, Variable};
pub use range::{HistoryRangeQuery, HistoryRangeResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct RetentionPolicy {
    pub retention_ms: u64,
    pub max_samples_per_variable: usize,
    pub max_total_samples: usize,
    pub max_logs: usize,
    pub max_closed_alarms: usize,
    pub min_sample_interval_ms: u64,
}
impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            retention_ms: 30 * 24 * 60 * 60 * 1000,
            max_samples_per_variable: 10_000,
            max_total_samples: 100_000,
            max_logs: 10_000,
            max_closed_alarms: 2000,
            min_sample_interval_ms: 250,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySample {
    pub id: i64,
    pub variable_id: String,
    pub timestamp: u64,
    pub value: f64,
    pub quality: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmRecord {
    pub id: i64,
    pub variable_id: String,
    pub variable_name: String,
    pub direction: String,
    pub threshold: f64,
    pub value: f64,
    pub started_at: u64,
    pub cleared_at: Option<u64>,
    pub acknowledged_at: Option<u64>,
    pub active: bool,
    pub acknowledged: bool,
}
#[derive(Clone)]
struct ActiveAlarm {
    id: i64,
    direction: String,
    threshold: f64,
}
#[derive(Clone)]
struct LastSample {
    recorded_at: u64,
    value: f64,
    quality: String,
}
pub struct HistoryStore {
    db: Connection,
    policy: RetentionPolicy,
    project_id: Option<String>,
    persisted: BTreeMap<String, (String, String)>,
    samples: BTreeMap<String, LastSample>,
    active: BTreeMap<String, ActiveAlarm>,
    seen_logs: BTreeSet<String>,
    last_data_hash: Option<[u8; 32]>,
    last_processed_at: u64,
}
impl HistoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        Self::open_with_policy(path, RetentionPolicy::default())
    }
    pub fn open_with_policy(
        path: impl AsRef<Path>,
        policy: RetentionPolicy,
    ) -> Result<Self, String> {
        if policy.max_samples_per_variable == 0
            || policy.max_total_samples == 0
            || policy.max_logs == 0
            || policy.max_closed_alarms == 0
        {
            return Err("Retention limits must be positive".into());
        }
        if let Some(parent) = path.as_ref().parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_millis(500))
            .map_err(|e| e.to_string())?;
        let version: u32 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > 1 {
            return Err(format!("Unsupported history database version {version}"));
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS history_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS persistent_values(variable_id TEXT PRIMARY KEY,value_type TEXT NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS history_samples(id INTEGER PRIMARY KEY AUTOINCREMENT,variable_id TEXT NOT NULL,timestamp INTEGER NOT NULL,recorded_at INTEGER NOT NULL,value REAL NOT NULL,quality TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS samples_variable_id ON history_samples(variable_id,id DESC);
            CREATE INDEX IF NOT EXISTS samples_variable_time ON history_samples(variable_id,timestamp,id);
            CREATE INDEX IF NOT EXISTS samples_timestamp ON history_samples(timestamp);
            CREATE TABLE IF NOT EXISTS runtime_logs(log_key TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL,node_id TEXT,flow_id TEXT);
            CREATE INDEX IF NOT EXISTS logs_timestamp ON runtime_logs(timestamp);
            CREATE TABLE IF NOT EXISTS alarms(id INTEGER PRIMARY KEY AUTOINCREMENT,variable_id TEXT NOT NULL,variable_name TEXT NOT NULL,direction TEXT NOT NULL,threshold REAL NOT NULL,value REAL NOT NULL,started_at INTEGER NOT NULL,cleared_at INTEGER,acknowledged_at INTEGER);
            CREATE INDEX IF NOT EXISTS alarms_active ON alarms(variable_id,cleared_at);
            CREATE INDEX IF NOT EXISTS alarms_started ON alarms(started_at);
            PRAGMA user_version=1;").map_err(|e|e.to_string())?;
        let project_id = db
            .query_row(
                "SELECT value FROM history_meta WHERE key='project_id'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let persisted = {
            let mut q = db
                .prepare("SELECT variable_id,value_type,value_json FROM persistent_values")
                .map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        (r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let samples = {
            let mut q=db.prepare("SELECT variable_id,recorded_at,value,quality FROM history_samples WHERE id IN (SELECT MAX(id) FROM history_samples GROUP BY variable_id)").map_err(|e|e.to_string())?;
            let rows = q
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        LastSample {
                            recorded_at: r.get(1)?,
                            value: r.get(2)?,
                            quality: r.get(3)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let active = {
            let mut q=db.prepare("SELECT variable_id,id,direction,threshold FROM alarms WHERE cleared_at IS NULL").map_err(|e|e.to_string())?;
            let rows = q
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        ActiveAlarm {
                            id: r.get(1)?,
                            direction: r.get(2)?,
                            threshold: r.get(3)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let seen_logs = {
            let mut q = db
                .prepare("SELECT log_key FROM runtime_logs ORDER BY timestamp DESC LIMIT 2000")
                .map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<BTreeSet<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        Ok(Self {
            db,
            policy,
            project_id,
            persisted,
            samples,
            active,
            seen_logs,
            last_data_hash: None,
            last_processed_at: 0,
        })
    }
    pub fn restore_values(&self, project: &Project) -> Result<BTreeMap<String, Value>, String> {
        if self
            .project_id
            .as_deref()
            .is_some_and(|id| id != project.id)
        {
            return Ok(BTreeMap::new());
        }
        let mut values = BTreeMap::new();
        for variable in project.variables.iter().filter(|v| v.persistent) {
            if let Some((kind, json)) = self.persisted.get(&variable.id) {
                if kind == &variable.value_type {
                    if let Ok(value) = serde_json::from_str::<Value>(json) {
                        if compatible(variable, &value) {
                            values.insert(variable.id.clone(), value);
                        }
                    }
                }
            }
        }
        Ok(values)
    }
    pub fn record_snapshot(
        &mut self,
        project: &Project,
        snapshot: &RuntimeSnapshot,
    ) -> Result<(), String> {
        self.record_at(project, snapshot, now_ms())
    }
    fn record_at(
        &mut self,
        project: &Project,
        snapshot: &RuntimeSnapshot,
        now: u64,
    ) -> Result<(), String> {
        if self
            .project_id
            .as_deref()
            .is_some_and(|id| id != project.id)
        {
            return Err("History database belongs to another project".into());
        }
        if project.variables.len() > 10_000 || snapshot.logs.len() > 10_000 {
            return Err("History snapshot exceeds variable/log limits".into());
        }
        // Value timestamps and running/active-node animation alone are not data
        // changes. Avoid even opening a write transaction for these snapshots.
        let relevant_values: Vec<_> = snapshot
            .values
            .iter()
            .map(|(id, v)| (id, &v.value, &v.quality))
            .collect();
        let hash: [u8; 32] = Sha256::digest(
            serde_json::to_vec(&(&project.variables, relevant_values, &snapshot.logs))
                .map_err(|e| e.to_string())?,
        )
        .into();
        let trailing_sample_ready = snapshot.values.iter().any(|(id, value)| {
            value
                .value
                .as_f64()
                .zip(self.samples.get(id))
                .is_some_and(|(number, last)| {
                    (number != last.value || value.quality != last.quality)
                        && now.saturating_sub(last.recorded_at)
                            >= self.policy.min_sample_interval_ms
                })
        });
        if self.last_data_hash == Some(hash)
            && !trailing_sample_ready
            && now.saturating_sub(self.last_processed_at)
                < self.policy.retention_ms.clamp(1, 60_000)
        {
            return Ok(());
        }
        let mut persisted = self.persisted.clone();
        let mut samples = self.samples.clone();
        let mut active = self.active.clone();
        let mut seen_logs = self.seen_logs.clone();
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO history_meta(key,value) VALUES('project_id',?1)",
            [&project.id],
        )
        .map_err(|e| e.to_string())?;
        let definitions: BTreeMap<&str, &Variable> = project
            .variables
            .iter()
            .map(|v| (v.id.as_str(), v))
            .collect();
        // Removed variables may remain queryable in SQL, but cannot grow the
        // in-memory sampling cache without bound across project edits.
        samples.retain(|id, _| definitions.contains_key(id.as_str()));
        for id in self.persisted.keys() {
            if !definitions.get(id.as_str()).is_some_and(|v| v.persistent) {
                tx.execute("DELETE FROM persistent_values WHERE variable_id=?1", [id])
                    .map_err(|e| e.to_string())?;
                persisted.remove(id);
            }
        }
        for (id, alarm) in &self.active {
            if !definitions.get(id.as_str()).is_some_and(|v| {
                v.value_type == "number"
                    && v.extra.get("alarm").is_some_and(|rule| {
                        rule.get("min").and_then(Value::as_f64).is_some()
                            || rule.get("max").and_then(Value::as_f64).is_some()
                    })
            }) {
                tx.execute(
                    "UPDATE alarms SET cleared_at=?1 WHERE id=?2",
                    params![now, alarm.id],
                )
                .map_err(|e| e.to_string())?;
                active.remove(id);
            }
        }
        let mut sampled = BTreeSet::new();
        for variable in &project.variables {
            let Some(current) = snapshot.values.get(&variable.id) else {
                continue;
            };
            if !compatible(variable, &current.value) {
                return Err(format!("History value type mismatch: {}", variable.id));
            }
            if variable.persistent && current.quality == "good" {
                let json = serde_json::to_string(&current.value).map_err(|e| e.to_string())?;
                let desired = (variable.value_type.clone(), json.clone());
                if persisted.get(&variable.id) != Some(&desired) {
                    tx.execute("INSERT INTO persistent_values(variable_id,value_type,value_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(variable_id) DO UPDATE SET value_type=excluded.value_type,value_json=excluded.value_json,updated_at=excluded.updated_at",params![variable.id,variable.value_type,json,now]).map_err(|e|e.to_string())?;
                    persisted.insert(variable.id.clone(), desired);
                }
            }
            if variable.value_type != "number" {
                continue;
            }
            let Some(value) = current.value.as_f64() else {
                continue;
            };
            if !value.is_finite() {
                return Err("Non-finite history sample".into());
            }
            let changed = samples
                .get(&variable.id)
                .map_or(true, |s| s.value != value || s.quality != current.quality);
            let ready = samples.get(&variable.id).map_or(true, |s| {
                now.saturating_sub(s.recorded_at) >= self.policy.min_sample_interval_ms
            });
            if changed && ready {
                let timestamp = if current.timestamp == 0 {
                    now
                } else {
                    current.timestamp.min(now)
                };
                tx.execute("INSERT INTO history_samples(variable_id,timestamp,recorded_at,value,quality) VALUES(?1,?2,?3,?4,?5)",params![variable.id,timestamp,now,value,current.quality]).map_err(|e|e.to_string())?;
                samples.insert(
                    variable.id.clone(),
                    LastSample {
                        recorded_at: now,
                        value,
                        quality: current.quality.clone(),
                    },
                );
                sampled.insert(variable.id.clone());
            }
            if current.quality != "good" {
                continue;
            }
            let rule = variable.extra.get("alarm");
            let min = rule.and_then(|r| r.get("min")).and_then(Value::as_f64);
            let max = rule.and_then(|r| r.get("max")).and_then(Value::as_f64);
            if min.zip(max).is_some_and(|(min, max)| min > max) {
                return Err(format!("Alarm minimum exceeds maximum: {}", variable.id));
            }
            let direction = if let Some(min) = min.filter(|min| value < *min) {
                Some(("low", min))
            } else {
                max.filter(|max| value > *max).map(|max| ("high", max))
            };
            let same = active.get(&variable.id).is_some_and(|a| {
                direction.is_some_and(|(d, t)| d == a.direction && t == a.threshold)
            });
            if !same {
                if let Some(previous) = active.remove(&variable.id) {
                    tx.execute(
                        "UPDATE alarms SET cleared_at=?1 WHERE id=?2",
                        params![now, previous.id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                if let Some((direction, threshold)) = direction {
                    tx.execute("INSERT INTO alarms(variable_id,variable_name,direction,threshold,value,started_at) VALUES(?1,?2,?3,?4,?5,?6)",params![variable.id,variable.name,direction,threshold,value,now]).map_err(|e|e.to_string())?;
                    active.insert(
                        variable.id.clone(),
                        ActiveAlarm {
                            id: tx.last_insert_rowid(),
                            direction: direction.into(),
                            threshold,
                        },
                    );
                }
            }
        }
        for log in &snapshot.logs {
            let key = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(log).map_err(|e| e.to_string())?)
            );
            if seen_logs.insert(key.clone()) {
                tx.execute("INSERT OR IGNORE INTO runtime_logs(log_key,timestamp,level,message,node_id,flow_id) VALUES(?1,?2,?3,?4,?5,?6)",params![key,log.time,log.level,log.message,log.node_id,log.flow_id]).map_err(|e|e.to_string())?;
            }
        }
        let cutoff = now.saturating_sub(self.policy.retention_ms);
        tx.execute("DELETE FROM history_samples WHERE timestamp<?1", [cutoff])
            .map_err(|e| e.to_string())?;
        for id in sampled {
            tx.execute("DELETE FROM history_samples WHERE variable_id=?1 AND id NOT IN (SELECT id FROM history_samples WHERE variable_id=?1 ORDER BY id DESC LIMIT ?2)",params![id,self.policy.max_samples_per_variable as i64]).map_err(|e|e.to_string())?;
        }
        tx.execute("DELETE FROM history_samples WHERE id NOT IN (SELECT id FROM history_samples ORDER BY id DESC LIMIT ?1)",[self.policy.max_total_samples as i64]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM runtime_logs WHERE timestamp<?1 OR rowid NOT IN (SELECT rowid FROM runtime_logs ORDER BY timestamp DESC,rowid DESC LIMIT ?2)",params![cutoff,self.policy.max_logs as i64]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM alarms WHERE cleared_at IS NOT NULL AND (cleared_at<?1 OR id NOT IN (SELECT id FROM alarms WHERE cleared_at IS NOT NULL ORDER BY id DESC LIMIT ?2))",params![cutoff,self.policy.max_closed_alarms as i64]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        if seen_logs.len() > 2000 {
            seen_logs.clear();
            for log in &snapshot.logs {
                seen_logs.insert(format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(log).map_err(|e| e.to_string())?)
                ));
            }
        }
        self.persisted = persisted;
        self.samples = samples;
        self.active = active;
        self.seen_logs = seen_logs;
        self.project_id = Some(project.id.clone());
        self.last_data_hash = Some(hash);
        self.last_processed_at = now;
        Ok(())
    }
    pub fn query_history(
        &self,
        variable_id: &str,
        limit: usize,
    ) -> Result<Vec<HistorySample>, String> {
        let mut q=self.db.prepare("SELECT id,variable_id,timestamp,value,quality FROM history_samples WHERE variable_id=?1 ORDER BY id DESC LIMIT ?2").map_err(|e|e.to_string())?;
        let mut rows = q
            .query_map(params![variable_id, limit.min(1000) as i64], |r| {
                Ok(HistorySample {
                    id: r.get(0)?,
                    variable_id: r.get(1)?,
                    timestamp: r.get(2)?,
                    value: r.get(3)?,
                    quality: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.reverse();
        Ok(rows)
    }
    pub fn query_alarms(&self, limit: usize) -> Result<Vec<AlarmRecord>, String> {
        let mut q=self.db.prepare("SELECT id,variable_id,variable_name,direction,threshold,value,started_at,cleared_at,acknowledged_at FROM alarms ORDER BY (cleared_at IS NULL) DESC,id DESC LIMIT ?1").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([limit.min(1000) as i64], |r| {
                let cleared_at = r.get::<_, Option<u64>>(7)?;
                let acknowledged_at = r.get::<_, Option<u64>>(8)?;
                Ok(AlarmRecord {
                    id: r.get(0)?,
                    variable_id: r.get(1)?,
                    variable_name: r.get(2)?,
                    direction: r.get(3)?,
                    threshold: r.get(4)?,
                    value: r.get(5)?,
                    started_at: r.get(6)?,
                    cleared_at,
                    acknowledged_at,
                    active: cleared_at.is_none(),
                    acknowledged: acknowledged_at.is_some(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
    pub fn ack_alarm(&mut self, id: i64) -> Result<(), String> {
        let changed = self
            .db
            .execute(
                "UPDATE alarms SET acknowledged_at=COALESCE(acknowledged_at,?1) WHERE id=?2",
                params![now_ms(), id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            Err(format!("Alarm does not exist: {id}"))
        } else {
            Ok(())
        }
    }
}
fn compatible(variable: &Variable, value: &Value) -> bool {
    match variable.value_type.as_str() {
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "json" => crate::validate_json(value).is_ok(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Engine, RuntimeValue};
    use serde_json::json;
    fn project() -> Project {
        serde_json::from_value(json!({"schemaVersion":1,"id":"history-project","name":"History","revision":1,"locale":"en","theme":{},"publish":{},"window":{"title":"History","width":800,"height":600,"minWidth":200,"minHeight":200,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#fff","contentRadius":0,"cornerPreference":"system"},"variables":[{"id":"sensor","name":"temperature","type":"number","initial":20,"persistent":true,"alarm":{"min":0,"max":50}},{"id":"transient","name":"transient","type":"boolean","initial":false}],"flows":[]})).unwrap()
    }
    fn snapshot(project: &Project, value: Value, time: u64) -> RuntimeSnapshot {
        let mut s = Engine::new(project.clone()).unwrap().snapshot();
        s.values.insert(
            "sensor".into(),
            RuntimeValue {
                value,
                quality: "good".into(),
                timestamp: time,
            },
        );
        s
    }
    #[test]
    fn json_persistence_round_trips_without_numeric_history_or_alarms() {
        let mut p = project();
        p.schema_version = 3;
        p.windows = Some(vec![]);
        p.variables[0].value_type = "json".into();
        p.variables[0].initial = serde_json::json!({"rows":[1,null]});
        let mut store = HistoryStore::open(":memory:").unwrap();
        let mut engine = Engine::new(p.clone()).unwrap();
        engine
            .set_variable("sensor", serde_json::json!({"rows":[2,{"ok":true}]}))
            .unwrap();
        store.record_snapshot(&p, &engine.snapshot()).unwrap();
        let restored = store.restore_values(&p).unwrap();
        assert_eq!(
            restored["sensor"],
            serde_json::json!({"rows":[2,{"ok":true}]})
        );
        engine
            .set_variable("sensor", serde_json::json!(99))
            .unwrap();
        store.record_snapshot(&p, &engine.snapshot()).unwrap();
        assert!(store.query_history("sensor", 100).unwrap().is_empty());
        assert!(store.query_alarms(100).unwrap().is_empty());
    }
    #[test]
    fn persistent_values_survive_reopen_and_respect_type_project_and_flag() {
        let path = std::env::temp_dir().join(format!(
            "quickgui-history-test-{}-{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        let mut project = project();
        let mut store = HistoryStore::open(&path).unwrap();
        store
            .record_at(&project, &snapshot(&project, json!(37), 1000), 1000)
            .unwrap();
        drop(store);
        let mut store = HistoryStore::open(&path).unwrap();
        assert_eq!(store.restore_values(&project).unwrap()["sensor"], json!(37));
        project.variables[0].name = "renamed".into();
        assert!(store
            .restore_values(&project)
            .unwrap()
            .contains_key("sensor"));
        project.variables[0].value_type = "string".into();
        assert!(store.restore_values(&project).unwrap().is_empty());
        project.variables[0].value_type = "number".into();
        project.variables[0].persistent = false;
        store
            .record_at(&project, &snapshot(&project, json!(40), 2000), 2000)
            .unwrap();
        project.variables[0].persistent = true;
        assert!(store.restore_values(&project).unwrap().is_empty());
        project.id = "other".into();
        assert!(store.restore_values(&project).unwrap().is_empty());
        drop(store);
        let _ = std::fs::remove_file(&path);
    }
    #[test]
    fn samples_are_deduplicated_rate_limited_and_bounded() {
        let project = project();
        let policy = RetentionPolicy {
            retention_ms: 1000,
            max_samples_per_variable: 3,
            max_total_samples: 5,
            min_sample_interval_ms: 100,
            ..Default::default()
        };
        let mut store = HistoryStore::open_with_policy(":memory:", policy).unwrap();
        for (time, value) in [
            (1000, 1),
            (1010, 1),
            (1020, 2),
            (1100, 2),
            (1200, 3),
            (1300, 4),
            (1400, 5),
        ] {
            store
                .record_at(&project, &snapshot(&project, json!(value), time), time)
                .unwrap();
        }
        assert_eq!(
            store
                .query_history("sensor", 100)
                .unwrap()
                .iter()
                .map(|s| s.value)
                .collect::<Vec<_>>(),
            vec![3., 4., 5.]
        );
        store
            .record_at(&project, &snapshot(&project, json!(6), 3000), 3000)
            .unwrap();
        assert_eq!(store.query_history("sensor", 100).unwrap().len(), 1);
        assert_eq!(store.restore_values(&project).unwrap()["sensor"], json!(6));
    }
    #[test]
    fn alarms_latch_and_acknowledgement_does_not_clear() {
        let project = project();
        let mut store = HistoryStore::open(":memory:").unwrap();
        store
            .record_at(&project, &snapshot(&project, json!(60), 1000), 1000)
            .unwrap();
        let alarm = store.query_alarms(10).unwrap().remove(0);
        assert!(alarm.active && !alarm.acknowledged);
        assert_eq!(alarm.direction, "high");
        store.ack_alarm(alarm.id).unwrap();
        store
            .record_at(&project, &snapshot(&project, json!(70), 1100), 1100)
            .unwrap();
        let alarms = store.query_alarms(10).unwrap();
        assert_eq!(alarms.len(), 1);
        assert!(alarms[0].active && alarms[0].acknowledged);
        let mut bad = snapshot(&project, json!(20), 1200);
        bad.values.get_mut("sensor").unwrap().quality = "bad".into();
        store.record_at(&project, &bad, 1200).unwrap();
        assert!(store.query_alarms(10).unwrap()[0].active);
        store
            .record_at(&project, &snapshot(&project, json!(20), 1300), 1300)
            .unwrap();
        assert!(!store.query_alarms(10).unwrap()[0].active);
        assert_eq!(store.query_alarms(10).unwrap()[0].cleared_at, Some(1300));
        assert!(store.ack_alarm(-1).is_err());
    }
    #[test]
    fn invalid_snapshot_rolls_back_persistent_state_and_history() {
        let mut project = project();
        let mut store = HistoryStore::open(":memory:").unwrap();
        store
            .record_at(&project, &snapshot(&project, json!(30), 1000), 1000)
            .unwrap();
        project.variables[0]
            .extra
            .insert("alarm".into(), json!({"min":100,"max":50}));
        assert!(store
            .record_at(&project, &snapshot(&project, json!(70), 2000), 2000)
            .is_err());
        assert_eq!(store.restore_values(&project).unwrap()["sensor"], json!(30));
        assert_eq!(store.query_history("sensor", 100).unwrap().len(), 1);
        assert!(store.query_alarms(100).unwrap().is_empty());
    }
    #[test]
    fn logs_are_deduplicated_and_closed_alarms_are_bounded_but_active_alarms_survive() {
        let project = project();
        let policy = RetentionPolicy {
            retention_ms: 1000,
            max_logs: 2,
            max_closed_alarms: 2,
            ..Default::default()
        };
        let mut store = HistoryStore::open_with_policy(":memory:", policy).unwrap();
        for i in 0..3 {
            let time = 1000 + i * 10;
            let mut s = snapshot(&project, json!(60), time);
            s.logs.push(crate::RuntimeLog {
                id: format!("log-{i}"),
                time,
                level: "info".into(),
                message: format!("message-{i}"),
                node_id: None,
                flow_id: None,
            });
            store.record_at(&project, &s, time).unwrap();
            store.record_at(&project, &s, time).unwrap();
            store
                .record_at(&project, &snapshot(&project, json!(20), time + 1), time + 1)
                .unwrap();
        }
        let count: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM runtime_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(store.query_alarms(100).unwrap().len(), 2);
        store
            .record_at(&project, &snapshot(&project, json!(60), 2000), 2000)
            .unwrap();
        store
            .record_at(&project, &snapshot(&project, json!(60), 10_000), 10_000)
            .unwrap();
        let alarms = store.query_alarms(100).unwrap();
        assert_eq!(alarms.len(), 1);
        assert!(alarms[0].active);
        assert_eq!(alarms[0].started_at, 2000);
    }
}
