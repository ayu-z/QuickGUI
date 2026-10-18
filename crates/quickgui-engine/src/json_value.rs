use serde_json::Value;

pub const MAX_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_JSON_DEPTH: usize = 32;

pub fn validate_json(value: &Value) -> Result<(), String> {
    fn depth(value: &Value, level: usize) -> Result<(), String> {
        if level > MAX_JSON_DEPTH {
            return Err("JSON depth exceeds 32".into());
        }
        match value {
            Value::Array(values) => {
                for value in values {
                    depth(value, level + 1)?;
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    depth(value, level + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    depth(value, 0)?;
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_JSON_BYTES {
        return Err("JSON value exceeds 1 MiB".into());
    }
    Ok(())
}

pub fn validate_path(path: &[Value]) -> Result<(), String> {
    if path.len() > MAX_JSON_DEPTH {
        return Err("JSON path exceeds depth 32".into());
    }
    if path
        .iter()
        .any(|part| !part.is_string() && !part.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
    {
        return Err("JSON path requires strings or nonnegative safe integer indices".into());
    }
    Ok(())
}

pub fn read_path<'a>(value: &'a Value, path: &[Value]) -> Result<&'a Value, String> {
    validate_path(path)?;
    let mut current = value;
    for part in path {
        current = match (current, part) {
            (Value::Object(object), Value::String(key)) => object.get(key),
            (Value::Array(array), Value::Number(index)) => index
                .as_u64()
                .and_then(|i| usize::try_from(i).ok())
                .and_then(|i| array.get(i)),
            _ => None,
        }
        .ok_or_else(|| format!("Missing JSON path segment: {part}"))?;
    }
    Ok(current)
}

pub fn replace_path(value: &Value, path: &[Value], replacement: Value) -> Result<Value, String> {
    validate_path(path)?;
    let mut next = value.clone();
    let mut current = &mut next;
    for part in path {
        current = match (current, part) {
            (Value::Object(object), Value::String(key)) => object.get_mut(key),
            (Value::Array(array), Value::Number(index)) => index
                .as_u64()
                .and_then(|i| usize::try_from(i).ok())
                .and_then(|i| array.get_mut(i)),
            _ => None,
        }
        .ok_or_else(|| format!("Missing JSON path segment: {part}"))?;
    }
    *current = replacement;
    validate_json(&next)?;
    Ok(next)
}
