use super::HistoryStore;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryRangeQuery {
    pub variable_ids: Vec<String>,
    pub from_ms: u64,
    pub to_ms: u64,
    pub aggregation: String,
    pub bucket_ms: Option<u64>,
    pub max_points_per_series: Option<usize>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub timestamp: u64,
    pub value: Option<f64>,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySeries {
    pub variable_id: String,
    pub truncated: bool,
    pub available_from_ms: Option<u64>,
    pub available_to_ms: Option<u64>,
    pub points: Vec<HistoryPoint>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRangeResult {
    pub from_ms: u64,
    pub to_ms: u64,
    pub aggregation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub series: Vec<HistorySeries>,
}
impl HistoryRangeQuery {
    pub fn validate(&self) -> Result<(usize, Option<(u64, usize)>), String> {
        let count = self.variable_ids.len();
        if count == 0
            || count > 16
            || self.variable_ids.iter().any(String::is_empty)
            || self.variable_ids.iter().collect::<BTreeSet<_>>().len() != count
        {
            return Err("History query requires 1..16 distinct variable IDs".into());
        }
        if self.from_ms >= self.to_ms || self.to_ms > 9_007_199_254_740_991 {
            return Err("History requires a valid UTC half-open [fromMs,toMs) range".into());
        }
        let limit = self.max_points_per_series.unwrap_or(1000);
        if limit == 0 || limit > 2000 || limit * count > 20000 {
            return Err("History limit exceeds 2000 points per series or 20000 total".into());
        }
        if self.aggregation == "raw" {
            if self.bucket_ms.is_some() {
                return Err("Raw history does not accept bucketMs".into());
            }
            return Ok((limit, None));
        }
        if !["avg", "min", "max", "last"].contains(&self.aggregation.as_str()) {
            return Err("Unsupported history aggregation".into());
        }
        let bucket = self
            .bucket_ms
            .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .ok_or("Aggregation requires a positive bucketMs")?;
        let start = self.from_ms / bucket * bucket;
        let buckets = (self.to_ms - 1 - start) / bucket + 1;
        if buckets > limit as u64 {
            return Err(
                "History bucket count exceeds maxPointsPerSeries; increase bucketMs".into(),
            );
        }
        Ok((limit, Some((start, buckets as usize))))
    }
}
impl HistoryStore {
    pub fn query_history_range(
        &self,
        query: &HistoryRangeQuery,
    ) -> Result<HistoryRangeResult, String> {
        let (limit, buckets) = query.validate()?;
        let mut series = Vec::new();
        for variable_id in &query.variable_ids {
            let (available_from_ms, available_to_ms) = self.db.query_row(
                "SELECT MIN(timestamp),MAX(timestamp) FROM history_samples WHERE variable_id=?1", [variable_id],
                |r| Ok((r.get::<_, Option<u64>>(0)?, r.get::<_, Option<u64>>(1)?)),
            ).map_err(|e| e.to_string())?;
            let mut points = Vec::new();
            let mut truncated = false;
            if let Some((start, count)) = buckets {
                let bucket = query.bucket_ms.unwrap();
                // Each bucket is epoch-aligned. Only good stored samples inside the
                // requested half-open range contribute; no interpolation/zero fill.
                let mut statement = self.db.prepare("SELECT timestamp,value FROM history_samples WHERE variable_id=?1 AND timestamp>=?2 AND timestamp<?3 AND quality='good' ORDER BY timestamp,id").map_err(|e| e.to_string())?;
                let mut rows = statement
                    .query(params![variable_id, query.from_ms, query.to_ms])
                    .map_err(|e| e.to_string())?;
                points = (0..count)
                    .map(|i| HistoryPoint {
                        timestamp: start + i as u64 * bucket,
                        value: None,
                        count: 0,
                        quality: None,
                        id: None,
                    })
                    .collect();
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let timestamp: u64 = row.get(0).map_err(|e| e.to_string())?;
                    let value: f64 = row.get(1).map_err(|e| e.to_string())?;
                    if !value.is_finite() {
                        return Err("History contains non-finite sample".into());
                    }
                    let point = &mut points[((timestamp - start) / bucket) as usize];
                    point.count += 1;
                    point.value = Some(match (point.value, query.aggregation.as_str()) {
                        (None, _) => value,
                        (Some(previous), "avg") => {
                            previous * ((point.count - 1) as f64 / point.count as f64)
                                + value / point.count as f64
                        }
                        (Some(previous), "min") => previous.min(value),
                        (Some(previous), "max") => previous.max(value),
                        (_, "last") => value,
                        _ => unreachable!(),
                    });
                }
            } else {
                let mut statement = self.db.prepare("SELECT id,timestamp,value,quality FROM history_samples WHERE variable_id=?1 AND timestamp>=?2 AND timestamp<?3 ORDER BY timestamp,id LIMIT ?4").map_err(|e| e.to_string())?;
                let mut rows = statement
                    .query(params![
                        variable_id,
                        query.from_ms,
                        query.to_ms,
                        (limit + 1) as i64
                    ])
                    .map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    if points.len() == limit {
                        truncated = true;
                        break;
                    }
                    points.push(HistoryPoint {
                        id: Some(row.get(0).map_err(|e| e.to_string())?),
                        timestamp: row.get(1).map_err(|e| e.to_string())?,
                        value: Some(row.get(2).map_err(|e| e.to_string())?),
                        count: 1,
                        quality: Some(row.get(3).map_err(|e| e.to_string())?),
                    });
                }
            }
            series.push(HistorySeries {
                variable_id: variable_id.clone(),
                truncated,
                available_from_ms,
                available_to_ms,
                points,
            });
        }
        Ok(HistoryRangeResult {
            from_ms: query.from_ms,
            to_ms: query.to_ms,
            aggregation: query.aggregation.clone(),
            bucket_ms: query.bucket_ms,
            project_id: self.project_id.clone(),
            series,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn query(aggregation: &str) -> HistoryRangeQuery {
        HistoryRangeQuery {
            variable_ids: vec!["v".into()],
            from_ms: 100,
            to_ms: 400,
            aggregation: aggregation.into(),
            bucket_ms: (aggregation != "raw").then_some(100),
            max_points_per_series: None,
        }
    }
    fn store() -> HistoryStore {
        let store = HistoryStore::open(":memory:").unwrap();
        for (time, value, quality) in [
            (99, 99., "good"),
            (100, 10., "good"),
            (150, 30., "good"),
            (150, 50., "good"),
            (170, 999., "bad"),
            (300, 40., "good"),
            (400, 999., "good"),
        ] {
            store.db.execute("INSERT INTO history_samples(variable_id,timestamp,recorded_at,value,quality) VALUES('v',?1,?1,?2,?3)", params![time,value,quality]).unwrap();
        }
        store
    }
    #[test]
    fn range_is_half_open_ordered_bounded_and_reports_truncation() {
        let store = store();
        let mut q = query("raw");
        q.max_points_per_series = Some(3);
        let result = store.query_history_range(&q).unwrap();
        let s = &result.series[0];
        assert!(s.truncated);
        assert_eq!(s.available_from_ms, Some(99));
        assert_eq!(s.available_to_ms, Some(400));
        assert_eq!(
            s.points
                .iter()
                .map(|p| p.value.unwrap())
                .collect::<Vec<_>>(),
            [10., 30., 50.]
        );
        q.max_points_per_series = None;
        let s = &store.query_history_range(&q).unwrap().series[0];
        assert_eq!(s.points.len(), 5);
        assert!(!s.truncated);
        assert_eq!(s.points[3].quality.as_deref(), Some("bad"));
    }
    #[test]
    fn aggregations_use_good_samples_and_keep_empty_buckets_null() {
        let store = store();
        for (aggregation, expected) in [("avg", 30.), ("min", 10.), ("max", 50.), ("last", 50.)] {
            let result = store.query_history_range(&query(aggregation)).unwrap();
            let p = &result.series[0].points;
            assert_eq!(p.len(), 3);
            assert_eq!(p[0].value, Some(expected));
            assert_eq!(p[0].count, 3);
            assert_eq!(p[1].timestamp, 200);
            assert_eq!(p[1].value, None);
            assert_eq!(p[1].count, 0);
            assert_eq!(p[2].value, Some(40.));
        }
    }
    #[test]
    fn query_limits_and_epoch_alignment_are_explicit() {
        let mut q = query("avg");
        q.bucket_ms = Some(0);
        assert!(q.validate().is_err());
        q = query("avg");
        q.max_points_per_series = Some(2);
        assert!(q.validate().is_err());
        q = query("raw");
        q.variable_ids.push("v".into());
        assert!(q.validate().is_err());
        q = query("raw");
        q.variable_ids = (0..16).map(|i| i.to_string()).collect();
        q.max_points_per_series = Some(2000);
        assert!(q.validate().is_err());
        q = query("avg");
        q.from_ms = 150;
        let result = store().query_history_range(&q).unwrap();
        assert_eq!(result.series[0].points[0].timestamp, 100);
        assert_eq!(result.series[0].points[0].value, Some(40.));
    }
}
