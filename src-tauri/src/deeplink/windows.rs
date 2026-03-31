use std::{
    io::{BufRead, BufReader, Result, Write},
    path::Path,
};

use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions, Stream};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use super::ID;

pub fn register<F: FnMut(String) + Send + 'static>(scheme: &str, handler: F) -> Result<()> {
    listen(handler)?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = Path::new("Software").join("Classes").join(scheme);

    let exe = std::env::current_exe()?
        .display()
        .to_string()
        .replace("\\\\?\\", "");

    let (key, _) = hkcu.create_subkey(&base)?;
    key.set_value(
        "",
        &format!(
            "URL:{}",
            ID.get().expect("register() called before prepare()")
        ),
    )?;
    key.set_value("URL Protocol", &"")?;

    let (icon, _) = hkcu.create_subkey(base.join("DefaultIcon"))?;
    icon.set_value("", &format!("{},0", &exe))?;

    let (cmd, _) = hkcu.create_subkey(base.join("shell").join("open").join("command"))?;
    cmd.set_value("", &format!("\"{}\" \"%1\"", &exe))?;

    Ok(())
}

fn listen<F: FnMut(String) + Send + 'static>(mut handler: F) -> Result<()> {
    std::thread::spawn(move || {
        let socket_name = ID
            .get()
            .expect("listen() called before prepare()")
            .as_str()
            .to_ns_name::<GenericNamespaced>()
            .expect("Failed to build local socket name");
        let listener = ListenerOptions::new()
            .name(socket_name)
            .create_sync()
            .expect("Can't create listener");

        for conn in listener.incoming().filter_map(|connection| {
            connection
                .map_err(|error| eprintln!("Incoming connection failed: {}", error))
                .ok()
        }) {
            let mut conn = BufReader::new(conn);
            let mut buffer = String::new();
            if let Err(error) = conn.read_line(&mut buffer) {
                eprintln!("Error reading incoming connection: {}", error);
                continue;
            }
            if buffer.ends_with('\n') {
                buffer.pop();
            }
            if buffer.ends_with('\r') {
                buffer.pop();
            }
            handler(buffer);
        }
    });

    Ok(())
}

pub fn prepare(identifier: &str) -> bool {
    let arg1 = std::env::args().nth(1).unwrap_or_default();
    let mut is_secondary_instance = false;

    let socket_name = identifier.to_ns_name::<GenericNamespaced>();
    if let Ok(name) = socket_name {
        if let Ok(mut conn) = Stream::connect(name) {
            is_secondary_instance = true;
            if let Err(error) = conn.write_all(arg1.as_bytes()) {
                eprintln!("Error sending message to primary instance: {}", error);
            }
            let _ = conn.write_all(b"\n");
        }
    }

    ID.set(identifier.to_string())
        .expect("prepare() called more than once with different identifiers.");

    is_secondary_instance
}
