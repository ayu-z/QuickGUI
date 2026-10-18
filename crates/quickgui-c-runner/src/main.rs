//! Native C execution stays in this disposable process. This is fault isolation,
//! not a security sandbox: only run source from trusted project authors.
use quickgui_engine::{ScriptRequest, ScriptResponse};
use std::{
    cell::RefCell,
    ffi::{c_char, CString},
    io::{self, BufRead, Read, Write},
};
#[cfg(not(feature = "aot"))]
use std::{
    ffi::{c_int, c_void, CStr},
    path::PathBuf,
};

#[cfg(not(feature = "aot"))]
const HEADER: &str = include_str!("../../../sdk/quickgui.h");
const MAX_LINE: u64 = 2 * 1024 * 1024;

struct Context {
    request: ScriptRequest,
    response: ScriptResponse,
    error: Option<String>,
    input_json: CString,
    input_string: Option<CString>,
}
thread_local! {static CONTEXT:RefCell<Option<Context>>=const{RefCell::new(None)};}

fn with_context<T: Default>(f: impl FnOnce(&mut Context) -> T) -> T {
    CONTEXT.with(|c| c.borrow_mut().as_mut().map(f).unwrap_or_default())
}
unsafe fn text(ptr: *const c_char) -> Option<String> {
    bounded_text(ptr, 4096)
}
unsafe fn bounded_text(ptr: *const c_char, limit: usize) -> Option<String> {
    if ptr.is_null() {
        with_context(|c| c.error = Some("Null host API string".into()));
        return None;
    }
    for n in 0..=limit {
        if *ptr.add(n) == 0 {
            let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), n);
            return match std::str::from_utf8(bytes) {
                Ok(s) => Some(s.to_owned()),
                Err(_) => {
                    with_context(|c| c.error = Some("Host API requires UTF-8".into()));
                    None
                }
            };
        }
    }
    with_context(|c| c.error = Some(format!("Host API string exceeds {limit} bytes")));
    None
}
#[no_mangle]
pub extern "C" fn qg_input_number() -> f64 {
    with_context(|c| match c.request.input.as_f64() {
        Some(value) if value.is_finite() => value,
        _ => {
            c.error=Some("qg_input_number requires a finite JSON number; use qg_input_json or qg_input_string".into());
            0.0
        }
    })
}
#[no_mangle]
pub extern "C" fn qg_input_json() -> *const c_char {
    with_context(|c| c.input_json.as_ptr())
}
#[no_mangle]
pub extern "C" fn qg_input_string() -> *const c_char {
    with_context(|c| match &c.input_string {
        Some(value) => value.as_ptr(),
        None => {
            c.error = Some(
                "qg_input_string requires a JSON string without embedded NUL; use qg_input_json"
                    .into(),
            );
            std::ptr::null()
        }
    })
}
#[no_mangle]
pub unsafe extern "C" fn qg_emit_json(value: *const c_char) {
    if let Some(value) = bounded_text(value, 1024 * 1024) {
        match serde_json::from_str::<serde_json::Value>(&value) {
            Ok(value) => with_context(|c| c.response.output = value),
            Err(error) => with_context(|c| {
                c.error = Some(format!("qg_emit_json received invalid JSON: {error}"))
            }),
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn qg_emit_string(value: *const c_char) {
    if let Some(value) = bounded_text(value, 1024 * 1024) {
        with_context(|c| c.response.output = serde_json::Value::String(value));
    }
}
#[no_mangle]
pub unsafe extern "C" fn qg_get_number(name: *const c_char) -> f64 {
    text(name)
        .map(|name| {
            with_context(|c| {
                c.response
                    .writes
                    .get(&name)
                    .or_else(|| c.request.variables.get(&name))
                    .copied()
                    .unwrap_or_else(|| {
                        c.error = Some(format!("Unknown numeric variable: {name}"));
                        0.0
                    })
            })
        })
        .unwrap_or(0.0)
}
#[no_mangle]
pub unsafe extern "C" fn qg_set_number(name: *const c_char, value: f64) {
    if let Some(name) = text(name) {
        with_context(|c| {
            if !value.is_finite() {
                c.error = Some("Non-finite variable write".into());
            } else if c.response.writes.len() >= 4096 {
                c.error = Some("Variable write limit exceeded".into());
            } else {
                c.response.writes.insert(name, value);
            }
        });
    }
}
#[no_mangle]
pub extern "C" fn qg_emit_number(value: f64) {
    with_context(|c| {
        if value.is_finite() {
            c.response.output = serde_json::json!(value);
        } else {
            c.error = Some("Non-finite script output".into());
        }
    });
}
#[no_mangle]
pub unsafe extern "C" fn qg_log(message: *const c_char) {
    if let Some(message) = text(message) {
        with_context(|c| {
            if c.response.logs.len() < 256 {
                c.response.logs.push(message);
            }
        });
    }
}
#[no_mangle]
pub unsafe extern "C" fn qg_state_get(name: *const c_char) -> f64 {
    text(name)
        .map(|name| with_context(|c| c.response.state.get(&name).copied().unwrap_or(0.0)))
        .unwrap_or(0.0)
}
#[no_mangle]
pub unsafe extern "C" fn qg_state_set(name: *const c_char, value: f64) {
    if let Some(name) = text(name) {
        with_context(|c| {
            if !value.is_finite() {
                c.error = Some("Non-finite script state".into());
            } else if c.response.state.len() >= 4096 {
                c.error = Some("State size limit exceeded".into());
            } else {
                c.response.state.insert(name, value);
            }
        });
    }
}

#[cfg(not(feature = "aot"))]
mod jit {
    use super::*;
    use libloading::Library;
    type State = *mut c_void;
    type New = unsafe extern "C" fn() -> State;
    type Delete = unsafe extern "C" fn(State);
    type SetText = unsafe extern "C" fn(State, *const c_char) -> c_int;
    type SetOutput = unsafe extern "C" fn(State, c_int) -> c_int;
    type AddSymbol = unsafe extern "C" fn(State, *const c_char, *const c_void) -> c_int;
    type Relocate = unsafe extern "C" fn(State) -> c_int; // pinned e23dabed ABI: ONE argument
    type GetSymbol = unsafe extern "C" fn(State, *const c_char) -> *mut c_void;
    type SetErrors =
        unsafe extern "C" fn(State, *mut c_void, unsafe extern "C" fn(*mut c_void, *const c_char));
    struct Compiler {
        library: Library,
        state: State,
        delete: Delete,
    }
    impl Drop for Compiler {
        fn drop(&mut self) {
            unsafe {
                (self.delete)(self.state);
            }
        }
    }
    unsafe extern "C" fn errors(context: *mut c_void, message: *const c_char) {
        if !context.is_null() && !message.is_null() {
            let log = &mut *context.cast::<Vec<String>>();
            if log.len() < 100 {
                log.push(
                    CStr::from_ptr(message)
                        .to_string_lossy()
                        .chars()
                        .take(4096)
                        .collect(),
                );
            }
        }
    }
    pub fn candidates() -> Vec<PathBuf> {
        if let Some(path) = std::env::var_os("QG_LIBTCC") {
            return vec![PathBuf::from(path)];
        }
        let name = if cfg!(target_os = "windows") {
            "libtcc.dll"
        } else if cfg!(target_os = "macos") {
            "libtcc.dylib"
        } else {
            "libtcc.so"
        };
        let mut paths = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                paths.push(dir.join(name));
                paths.push(dir.join("toolchain/lib").join(name));
                #[cfg(debug_assertions)]
                for ancestor in dir.ancestors().take(4) {
                    paths.push(ancestor.join(".toolchain/lib").join(name));
                }
            }
        }
        paths.push(PathBuf::from(".toolchain/lib").join(name));
        paths
    }
    fn load() -> Result<(Library, PathBuf), String> {
        let mut failures = Vec::new();
        for path in candidates() {
            match unsafe { Library::new(&path) } {
                Ok(lib) => return Ok((lib, path)),
                Err(e) => failures.push(format!("{}: {e}", path.display())),
            }
        }
        Err(format!("libtcc is unavailable. Run node scripts/setup-tcc.mjs or set QG_LIBTCC to the pinned library. {}",failures.join("; ")))
    }
    pub fn available() -> Result<String, String> {
        load().map(|(_, path)| path.display().to_string())
    }
    pub unsafe fn execute(source: &str, check_only: bool) -> Result<(), String> {
        let (library, path) = load()?;
        let new: New = *library.get(b"tcc_new\0").map_err(|e| e.to_string())?;
        let delete: Delete = *library.get(b"tcc_delete\0").map_err(|e| e.to_string())?;
        let state = new();
        if state.is_null() {
            return Err("libtcc failed to allocate a compilation context".into());
        }
        let mut diagnostics = Vec::<String>::new();
        let compiler = Compiler {
            library,
            state,
            delete,
        };
        let set_errors: SetErrors = *compiler
            .library
            .get(b"tcc_set_error_func\0")
            .map_err(|e| e.to_string())?;
        set_errors(state, (&mut diagnostics as *mut Vec<String>).cast(), errors);
        let set_path: unsafe extern "C" fn(State, *const c_char) = *compiler
            .library
            .get(b"tcc_set_lib_path\0")
            .map_err(|e| e.to_string())?;
        let home = std::env::var_os("QG_TCC_HOME")
            .map(PathBuf::from)
            .or_else(|| path.parent().map(|p| p.join("tcc")));
        if let Some(home) = home {
            if home.is_dir() {
                let home =
                    CString::new(home.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
                set_path(state, home.as_ptr());
            }
        }
        let options: SetText = *compiler
            .library
            .get(b"tcc_set_options\0")
            .map_err(|e| e.to_string())?;
        options(state, c"-nostdlib".as_ptr());
        let output: SetOutput = *compiler
            .library
            .get(b"tcc_set_output_type\0")
            .map_err(|e| e.to_string())?;
        if output(state, 1) < 0 {
            return Err(diagnostics.join("\n"));
        }
        let add: AddSymbol = *compiler
            .library
            .get(b"tcc_add_symbol\0")
            .map_err(|e| e.to_string())?;
        let symbols: [(&CStr, *const c_void); 11] = [
            (c"qg_input_number", qg_input_number as *const c_void),
            (c"qg_input_json", qg_input_json as *const c_void),
            (c"qg_input_string", qg_input_string as *const c_void),
            (c"qg_get_number", qg_get_number as *const c_void),
            (c"qg_set_number", qg_set_number as *const c_void),
            (c"qg_emit_number", qg_emit_number as *const c_void),
            (c"qg_emit_json", qg_emit_json as *const c_void),
            (c"qg_emit_string", qg_emit_string as *const c_void),
            (c"qg_log", qg_log as *const c_void),
            (c"qg_state_get", qg_state_get as *const c_void),
            (c"qg_state_set", qg_state_set as *const c_void),
        ];
        for (name, pointer) in symbols {
            if add(state, name.as_ptr(), pointer) < 0 {
                return Err(format!(
                    "Cannot register host symbol {}",
                    name.to_string_lossy()
                ));
            }
        }
        // The SDK is embedded, so source exports can use the same ordinary include.
        let source = source
            .lines()
            .map(|line| {
                if matches!(
                    line.trim(),
                    "#include \"quickgui.h\"" | "#include <quickgui.h>"
                ) {
                    ""
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let source = CString::new(format!("{HEADER}\n#line 1 \"script.c\"\n{source}\n"))
            .map_err(|_| "C source contains NUL".to_owned())?;
        let compile: SetText = *compiler
            .library
            .get(b"tcc_compile_string\0")
            .map_err(|e| e.to_string())?;
        if compile(state, source.as_ptr()) < 0 {
            return Err(format!("C compile error:\n{}", diagnostics.join("\n")));
        }
        let relocate: Relocate = *compiler
            .library
            .get(b"tcc_relocate\0")
            .map_err(|e| e.to_string())?;
        if relocate(state) < 0 {
            return Err(format!(
                "C link/relocation error:\n{}",
                diagnostics.join("\n")
            ));
        }
        let get: GetSymbol = *compiler
            .library
            .get(b"tcc_get_symbol\0")
            .map_err(|e| e.to_string())?;
        let entry = get(state, c"qg_process".as_ptr());
        if entry.is_null() {
            return Err("C source must define void qg_process(void)".into());
        }
        if !check_only {
            let process: unsafe extern "C" fn() = std::mem::transmute(entry);
            process();
        }
        // Compiler is dropped while diagnostics is still alive.
        drop(compiler);
        Ok(())
    }
}

fn execute(request: ScriptRequest, check_only: bool) -> Result<ScriptResponse, String> {
    if request.source.len() > 1024 * 1024 {
        return Err("C source exceeds 1 MiB".into());
    }
    if request.variables.len() > 4096 || request.state.len() > 4096 {
        return Err("C variable/state limit exceeded".into());
    }
    if request
        .variables
        .values()
        .chain(request.state.values())
        .any(|n| !n.is_finite())
    {
        return Err("C input must contain finite numbers".into());
    }
    let source = request.source.clone();
    let input_json = serde_json::to_string(&request.input).map_err(|e| e.to_string())?;
    if input_json.len() > 1024 * 1024 {
        return Err("C JSON input exceeds 1 MiB".into());
    }
    let input_json = CString::new(input_json).map_err(|e| e.to_string())?;
    let input_string = request.input.as_str().and_then(|s| CString::new(s).ok());
    let response = ScriptResponse {
        output: request.input.clone(),
        state: request.state.clone(),
        ..Default::default()
    };
    CONTEXT.with(|c| {
        *c.borrow_mut() = Some(Context {
            request,
            response,
            error: None,
            input_json,
            input_string,
        })
    });
    #[cfg(not(feature = "aot"))]
    let result = unsafe { jit::execute(&source, check_only) };
    #[cfg(feature = "aot")]
    let result = {
        use sha2::{Digest, Sha256};
        if format!("{:x}", Sha256::digest(source.as_bytes())) != env!("QG_AOT_HASH") {
            Err("C source does not match this AOT worker; rebuild it".into())
        } else {
            if !check_only {
                unsafe {
                    extern "C" {
                        fn qg_process();
                    }
                    qg_process();
                }
            }
            Ok::<(), String>(())
        }
    };
    let context = CONTEXT
        .with(|c| c.borrow_mut().take())
        .ok_or("C context missing")?;
    result?;
    if let Some(error) = context.error {
        return Err(error);
    }
    Ok(context.response)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(argument) = args
        .iter()
        .skip(1)
        .find(|arg| !matches!(arg.as_str(), "--check" | "--capabilities" | "--self-test"))
    {
        eprintln!("Unsupported C worker argument: {argument}");
        std::process::exit(2);
    }
    let check_only = args.iter().any(|a| a == "--check");
    if args.iter().any(|a| a == "--capabilities") {
        #[cfg(not(feature = "aot"))]
        let capability = match jit::available() {
            Ok(path) => {
                serde_json::json!({"available":true,"mode":"jit","hostAbi":2,"compileCheck":true,"library":path})
            }
            Err(error) => {
                serde_json::json!({"available":false,"mode":"jit","hostAbi":2,"compileCheck":true,"error":error})
            }
        };
        #[cfg(feature = "aot")]
        let capability =
            serde_json::json!({"available":true,"mode":"aot","hostAbi":2,"compileCheck":true});
        println!("{capability}");
        return;
    }
    if args.iter().any(|a| a == "--self-test") {
        #[cfg(not(feature="aot"))] let source="void qg_process(void){qg_emit_number(qg_input_number()*3);qg_state_set(\"runs\",qg_state_get(\"runs\")+1);qg_log(\"C self-test\");}";
        #[cfg(feature = "aot")]
        let source = include_str!(concat!(env!("OUT_DIR"), "/aot_script.c"));
        let request = ScriptRequest {
            source: source.into(),
            input: serde_json::json!(7),
            variables: Default::default(),
            state: Default::default(),
            timeout_ms: 1000,
        };
        match execute(request, check_only) {
            Ok(response) => println!("{}", serde_json::to_string(&response).unwrap()),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let mut line = String::new();
        let read = reader.by_ref().take(MAX_LINE + 1).read_line(&mut line);
        match read {
            Ok(0) => break,
            Ok(_) if line.len() as u64 > MAX_LINE => {
                println!("{{\"error\":\"Request exceeds 2 MiB\"}}");
                break;
            }
            Err(error) => {
                eprintln!("{error}");
                break;
            }
            _ => {}
        }
        let result = serde_json::from_str::<ScriptRequest>(&line)
            .map_err(|e| format!("Invalid ScriptRequest: {e}"))
            .and_then(|request| execute(request, check_only));
        let response = match result {
            Ok(response) => serde_json::to_value(response).unwrap(),
            Err(error) => serde_json::json!({"error":error}),
        };
        println!("{response}");
        let _ = io::stdout().flush();
    }
}
