use crate::{Project, RuntimeWindowState, WindowConfig};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(crate) fn ids(project: &Project) -> BTreeSet<&str> {
    std::iter::once("main")
        .chain(
            project
                .windows
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|window| window.id.as_str()),
        )
        .collect()
}

fn validate_config(config: &WindowConfig) -> Result<(), String> {
    if !(200.0..=10000.0).contains(&config.width)
        || !(100.0..=10000.0).contains(&config.height)
        || !(0.0..=config.width).contains(&config.min_width)
        || !(0.0..=config.height).contains(&config.min_height)
    {
        return Err("Invalid window dimensions".into());
    }
    Ok(())
}

fn blank_name(name: &str) -> bool {
    // Match JavaScript String.trim() without normalizing the saved name.
    name.chars().all(|c| {
        matches!(c,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

struct References<'a> {
    variables: BTreeSet<&'a str>,
    flows: BTreeSet<&'a str>,
    modules: BTreeMap<&'a str, &'a Value>,
}

fn validate_widgets<'a>(
    widgets: &'a [Value],
    references: &References<'_>,
    scope: &str,
) -> Result<BTreeSet<&'a str>, String> {
    let mut parents = BTreeMap::new();
    for widget in widgets {
        let id = widget
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("Missing widget ID in {scope}"))?;
        let parent = match widget.get("parentId") {
            None => None,
            Some(Value::String(parent)) if parent.is_empty() => None,
            Some(Value::String(parent)) => Some(parent.as_str()),
            Some(_) => return Err(format!("Invalid parent reference for widget {id}")),
        };
        if parents.insert(id, parent).is_some() {
            return Err(format!("Duplicate widget ID in {scope}: {id}"));
        }
        if let Some(bindings) = widget.get("bindings") {
            let bindings = bindings
                .as_object()
                .ok_or_else(|| format!("Invalid widget bindings: {id}"))?;
            for binding in bindings.values() {
                let variable = binding
                    .get("variable")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !references.variables.contains(variable) {
                    return Err(format!("Missing variable for widget {id}: {variable}"));
                }
            }
        }
        if let Some(events) = widget.get("events") {
            let events = events
                .as_object()
                .ok_or_else(|| format!("Invalid widget events: {id}"))?;
            for flow in events.values() {
                let flow = flow.as_str().unwrap_or("");
                if !references.flows.contains(flow) {
                    return Err(format!("Missing flow for widget {id}: {flow}"));
                }
            }
        }
        if widget.get("type").and_then(Value::as_str) == Some("module") {
            let module = widget
                .get("moduleId")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Missing module for widget {id}"))?;
            if !references.modules.contains_key(module) {
                return Err(format!("Missing module for widget {id}: {module}"));
            }
        }
    }
    for (id, parent) in &parents {
        if parent.is_some_and(|parent| !parents.contains_key(parent)) {
            return Err(format!(
                "Missing parent in {scope} for widget {id}: {}",
                parent.unwrap()
            ));
        }
    }
    let mut complete = BTreeSet::new();
    for id in parents.keys() {
        let mut cursor = Some(*id);
        let mut visiting = BTreeSet::new();
        while let Some(current) = cursor {
            if complete.contains(current) {
                break;
            }
            if !visiting.insert(current) {
                return Err(format!("Cyclic parent reference in {scope}: {current}"));
            }
            cursor = parents[current];
        }
        complete.extend(visiting);
    }
    Ok(parents.into_keys().collect())
}

fn validate_content(project: &Project) -> Result<(), String> {
    let mut modules = BTreeMap::new();
    for module in &project.modules {
        let id = module
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Missing module ID")?;
        if modules.insert(id, module).is_some() {
            return Err(format!("Duplicate module ID: {id}"));
        }
    }
    let references = References {
        variables: project
            .variables
            .iter()
            .flat_map(|variable| [variable.id.as_str(), variable.name.as_str()])
            .collect(),
        flows: project.flows.iter().map(|flow| flow.id.as_str()).collect(),
        modules,
    };
    let assets: BTreeSet<_> = project
        .assets
        .iter()
        .filter_map(|asset| asset.get("id").and_then(Value::as_str))
        .collect();
    let icons = std::iter::once(project.window.icon.as_deref())
        .chain(
            project
                .windows
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|window| window.config.icon.as_deref()),
        )
        .chain([
            project.publish.get("icon").and_then(Value::as_str),
            project.publish.get("shortcutIcon").and_then(Value::as_str),
        ]);
    for icon in icons.flatten().filter(|icon| !icon.is_empty()) {
        if !assets.contains(icon) {
            return Err(format!("Missing icon asset: {icon}"));
        }
    }
    let mut placed = BTreeSet::new();
    for (id, widgets) in std::iter::once(("main", project.widgets.as_slice())).chain(
        project
            .windows
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|window| (window.id.as_str(), window.widgets.as_slice())),
    ) {
        if widgets.len() > 10_000 {
            return Err(format!("Window {id} exceeds the widget limit"));
        }
        for widget in validate_widgets(widgets, &references, id)? {
            if !placed.insert(widget) {
                return Err(format!(
                    "Duplicate widget ID across project windows: {widget}"
                ));
            }
        }
    }
    let mut indegree: BTreeMap<_, usize> = references.modules.keys().map(|id| (*id, 0)).collect();
    let mut edges = BTreeMap::<&str, Vec<&str>>::new();
    for (id, module) in &references.modules {
        let widgets = module
            .get("widgets")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("Invalid widgets for module {id}"))?;
        let local_ids = validate_widgets(widgets, &references, id)?;
        let is_react = module
            .get("implementation")
            .and_then(|implementation| implementation.get("kind"))
            .and_then(Value::as_str)
            == Some("react");
        if let Some(exposed) = module.get("exposedProps") {
            for property in exposed
                .as_object()
                .ok_or_else(|| format!("Invalid exposed properties for module {id}"))?
                .values()
            {
                let target = property
                    .get("widgetId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("Missing exposed widget target in module {id}"))?;
                if (is_react && target != "$component")
                    || (!is_react && !local_ids.contains(target))
                {
                    return Err(format!(
                        "Missing exposed widget target in module {id}: {target}"
                    ));
                }
            }
        }
        for widget in widgets
            .iter()
            .filter(|widget| widget.get("type").and_then(Value::as_str) == Some("module"))
        {
            let child = widget.get("moduleId").and_then(Value::as_str).unwrap();
            *indegree.get_mut(child).unwrap() += 1;
            edges.entry(id).or_default().push(child);
        }
    }
    let mut queue: VecDeque<_> = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect();
    let mut count = 0;
    while let Some(id) = queue.pop_front() {
        count += 1;
        if let Some(children) = edges.get(id) {
            for child in children {
                let degree = indegree.get_mut(child).unwrap();
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(*child);
                }
            }
        }
    }
    if count != references.modules.len() {
        return Err("Cyclic module reference".into());
    }
    Ok(())
}

pub(crate) fn validate(project: &Project) -> Result<(), String> {
    if !matches!(project.schema_version, 1 | 2 | 3) {
        return Err(format!(
            "Unsupported project schema {}",
            project.schema_version
        ));
    }
    if (project.schema_version == 1 && project.windows.is_some())
        || (project.schema_version >= 2 && project.windows.is_none())
    {
        return Err("Additional windows require schemaVersion 2 or 3 and a windows array".into());
    }
    let windows = project.windows.as_deref().unwrap_or_default();
    if windows.len() > 31 {
        return Err("A project supports at most 32 windows".into());
    }
    validate_config(&project.window)?;
    let mut known = BTreeSet::from(["main"]);
    for window in windows {
        let id = &window.id;
        if id.len() > 64
            || !id.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || !known.insert(id.as_str())
        {
            return Err(format!("Invalid or duplicate window ID: {id}"));
        }
        if blank_name(&window.name) || window.name.encode_utf16().count() > 200 {
            return Err("Invalid window name".into());
        }
        validate_config(&window.config)?;
    }
    validate_content(project)?;
    for node in project
        .flows
        .iter()
        .flat_map(|flow| &flow.nodes)
        .filter(|node| node.kind == "window")
    {
        if project.schema_version < 2 {
            return Err("Window actions require schemaVersion 2 or 3".into());
        }
        let action = node
            .config
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let id = node
            .config
            .get("windowId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        validate_action(project, action, id)?;
    }
    Ok(())
}

pub(crate) fn validate_action(project: &Project, action: &str, id: &str) -> Result<(), String> {
    if !matches!(action, "open" | "close" | "focus") {
        return Err(format!("Unknown window action: {action}"));
    }
    if !ids(project).contains(id) {
        return Err(format!("Unknown window: {id}"));
    }
    if action == "close" && id == "main" {
        return Err("The main window cannot be closed by a window action".into());
    }
    Ok(())
}

pub(crate) fn initial(project: &Project) -> RuntimeWindowState {
    RuntimeWindowState {
        open: std::iter::once("main".to_owned())
            .chain(
                project
                    .windows
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .filter(|window| window.open_on_start)
                    .map(|window| window.id.clone()),
            )
            .collect(),
        ..Default::default()
    }
}

pub(crate) fn reconcile(
    previous: &Project,
    project: &Project,
    state: &RuntimeWindowState,
) -> RuntimeWindowState {
    let old_ids = ids(previous);
    let next_ids = ids(project);
    let mut next = state.clone();
    next.open.retain(|id| next_ids.contains(id.as_str()));
    for window in project.windows.as_deref().unwrap_or_default() {
        if !old_ids.contains(window.id.as_str()) && window.open_on_start {
            next.open.push(window.id.clone());
        }
    }
    if !next.open.contains(&next.focused) {
        next.focused = "main".into();
    }
    if next.open != state.open || next.focused != state.focused {
        next.revision = state.revision.saturating_add(1);
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;
    use serde_json::json;

    fn widget(id: &str, kind: &str) -> Value {
        json!({"id":id,"name":id,"type":kind,"layout":{"x":0,"y":0,"width":200,"height":100},"props":{},"style":{},"states":{},"bindings":{},"events":{}})
    }

    fn fixture() -> Project {
        let config = json!({"title":"Main","width":800,"height":600,"minWidth":200,"minHeight":100,"resizable":true,"alwaysOnTop":false,"fullscreen":false,"maximized":false,"center":true,"rememberPosition":false,"background":"#000000","contentRadius":0,"cornerPreference":"system"});
        let mut child_config = config.clone();
        child_config["icon"] = json!("icon");
        let mut instance = widget("details-card", "module");
        instance["parentId"] = json!("details-root");
        instance["moduleId"] = json!("card");
        let mut local = widget("main-root", "text");
        local["bindings"] = json!({"text":{"variable":"speed","mode":"oneWay"}});
        local["events"] = json!({"click":"flow"});
        serde_json::from_value(json!({
            "schemaVersion":2,"id":"windows-test","name":"Windows","revision":1,"locale":"en","theme":{},"publish":{},
            "window":config,"widgets":[widget("main-root","panel")],
            "windows":[{"id":"details","name":"Details","config":child_config,"widgets":[widget("details-root","panel"),instance],"openOnStart":false}],
            "variables":[{"id":"speed-id","name":"speed","type":"number","initial":0}],
            "flows":[{"id":"flow","name":"Flow","enabled":true,"nodes":[{"id":"event","kind":"event","label":"Event","config":{}}],"edges":[]}],
            "modules":[{"id":"card","name":"Card","version":"1.0.0","width":200,"height":100,"widgets":[local],"exposedProps":{"text":{"widgetId":"main-root","property":"text","default":""}}}],
            "assets":[{"id":"icon","name":"Icon","mime":"image/png","data":"data:image/png;base64,AA=="}]
        })).unwrap()
    }

    #[test]
    fn explicit_null_is_rejected_but_missing_legacy_windows_remain_unchanged() {
        let original = serde_json::to_value(fixture()).unwrap();
        for version in [1, 2] {
            let mut raw = original.clone();
            raw["schemaVersion"] = json!(version);
            raw["windows"] = Value::Null;
            assert!(serde_json::from_value::<Project>(raw).is_err());
        }
        let mut legacy = original;
        legacy["schemaVersion"] = json!(1);
        legacy.as_object_mut().unwrap().remove("windows");
        legacy.as_object_mut().unwrap().remove("widgets");
        let parsed: Project = serde_json::from_value(legacy).unwrap();
        assert!(parsed.widgets.is_empty());
        validate(&parsed).unwrap();
        assert!(serde_json::to_value(parsed)
            .unwrap()
            .get("windows")
            .is_none());
    }

    #[test]
    fn names_match_javascript_trim_and_utf16_bounds_without_normalizing() {
        for name in ["", "   ", "\t\n", "\u{3000}", "\u{feff}"] {
            let mut project = fixture();
            project.windows.as_mut().unwrap()[0].name = name.into();
            assert!(validate(&project).unwrap_err().contains("window name"));
        }
        let mut project = fixture();
        project.windows.as_mut().unwrap()[0].name = "  Details  ".into();
        validate(&project).unwrap();
        assert_eq!(project.windows.as_ref().unwrap()[0].name, "  Details  ");
        project.windows.as_mut().unwrap()[0].name = "😀".repeat(100);
        validate(&project).unwrap();
        project.windows.as_mut().unwrap()[0].name.push('😀');
        assert!(validate(&project).is_err());
    }

    #[test]
    fn window_widget_ids_are_global_but_module_widget_ids_are_local() {
        let mut project = fixture();
        validate(&project).unwrap(); // module-local main-root intentionally matches the scene ID.
        project.modules.push(project.modules[0].clone());
        project.modules[1]["id"] = json!("second-card");
        validate(&project).unwrap();
        project.windows.as_mut().unwrap()[0]
            .widgets
            .push(widget("main-root", "text"));
        assert!(validate(&project)
            .unwrap_err()
            .contains("across project windows"));
    }

    #[test]
    fn parent_references_cannot_cross_windows_or_form_cycles() {
        let mut project = fixture();
        project.windows.as_mut().unwrap()[0].widgets[1]["parentId"] = json!("main-root");
        assert!(validate(&project).unwrap_err().contains("Missing parent"));
        let mut project = fixture();
        project.widgets[0]["parentId"] = json!("details-root");
        assert!(validate(&project).unwrap_err().contains("Missing parent"));
        let mut project = fixture();
        project.windows.as_mut().unwrap()[0].widgets[0]["parentId"] = json!("details-card");
        assert!(validate(&project).unwrap_err().contains("Cyclic parent"));
    }

    #[test]
    fn every_window_uses_canonical_icon_variable_flow_and_module_references() {
        let cases: [(&str, fn(&mut Project)); 4] = [
            ("Missing icon", |p| {
                p.windows.as_mut().unwrap()[0].config.icon = Some("missing".into())
            }),
            ("Missing variable", |p| {
                p.windows.as_mut().unwrap()[0].widgets[1]["bindings"] =
                    json!({"value":{"variable":"missing","mode":"oneWay"}})
            }),
            ("Missing flow", |p| {
                p.windows.as_mut().unwrap()[0].widgets[1]["events"] = json!({"click":"missing"})
            }),
            ("Missing module", |p| {
                p.windows.as_mut().unwrap()[0].widgets[1]["moduleId"] = json!("missing")
            }),
        ];
        for (expected, change) in cases {
            let mut project = fixture();
            change(&mut project);
            let original = serde_json::to_value(&project).unwrap();
            assert!(validate(&project).unwrap_err().contains(expected));
            assert_eq!(serde_json::to_value(&project).unwrap(), original);
        }
    }

    #[test]
    fn unused_modules_validate_internal_bindings_events_and_exposed_targets() {
        let mut project = fixture();
        project.windows.as_mut().unwrap()[0].widgets.pop();
        project.modules[0]["widgets"][0]["bindings"]["text"]["variable"] = json!("missing");
        assert!(validate(&project).unwrap_err().contains("Missing variable"));
        project.modules[0]["widgets"][0]["bindings"] = json!({});
        project.modules[0]["widgets"][0]["events"]["click"] = json!("missing");
        assert!(validate(&project).unwrap_err().contains("Missing flow"));
        project.modules[0]["widgets"][0]["events"] = json!({});
        project.modules[0]["exposedProps"]["text"]["widgetId"] = json!("details-root");
        assert!(validate(&project)
            .unwrap_err()
            .contains("Missing exposed widget target"));
        project.modules[0]["implementation"] = json!({"kind":"react"});
        project.modules[0]["widgets"] = json!([]);
        project.modules[0]["exposedProps"]["text"]["widgetId"] = json!("$component");
        validate(&project).unwrap();
    }

    #[test]
    fn missing_nested_modules_and_module_cycles_are_rejected() {
        let mut project = fixture();
        let mut nested = widget("nested", "module");
        nested["moduleId"] = json!("second-card");
        project.modules[0]["widgets"]
            .as_array_mut()
            .unwrap()
            .push(nested.clone());
        assert!(validate(&project).unwrap_err().contains("Missing module"));
        nested["moduleId"] = json!("card");
        project
            .modules
            .push(json!({"id":"second-card","widgets":[nested],"exposedProps":{}}));
        assert!(validate(&project).unwrap_err().contains("Cyclic module"));
    }

    #[test]
    fn invalid_updates_preserve_running_values_and_existing_open_extra_data() {
        let mut project = fixture();
        project
            .extra
            .insert("vendorPayload".into(), json!({"preserved":true}));
        project
            .window
            .extra
            .insert("vendorWindow".into(), json!({"preserved":true}));
        project.widgets[0]["vendorWidget"] = json!({"preserved":true});
        let original = serde_json::to_value(&project).unwrap();
        validate(&project).unwrap();
        assert_eq!(serde_json::to_value(&project).unwrap(), original);
        let mut engine = Engine::new(project.clone()).unwrap();
        engine.set_variable("speed-id", json!(99)).unwrap();
        project.windows.as_mut().unwrap()[0].widgets[0]["parentId"] = json!("main-root");
        assert!(engine.apply_project(project).is_err());
        assert_eq!(engine.snapshot().values["speed-id"].value, json!(99));
        assert_eq!(serde_json::to_value(engine.project()).unwrap(), original);
    }
}
