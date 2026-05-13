use crate::allow_file_in_scopes;
use std::path::PathBuf;
use tauri::menu::MenuEvent;
use tauri::menu::{MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID};
use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, serde::Serialize)]
#[allow(dead_code)]
struct OpenFilesPayload {
    files: Vec<String>,
}

pub fn setup_macos_menu(app: &AppHandle) -> tauri::Result<()> {
    let global_menu = app.menu().unwrap();

    if let Some(item) = global_menu.get(HELP_SUBMENU_ID) {
        global_menu.remove(&item)?;
    }

    let open_item = MenuItemBuilder::new("Open...")
        .id("open_file")
        .accelerator("Cmd+O")
        .build(app)?;

    if let Some(file_menu) = global_menu.items()?.iter().find(|item| {
        if let Some(submenu) = item.as_submenu() {
            submenu.text().ok().as_deref() == Some("File")
        } else {
            false
        }
    }) {
        if let Some(file_submenu) = file_menu.as_submenu() {
            file_submenu.insert(&open_item, 0)?;
        }
    }

    // Insert "Readest Settings..." right after "About Readest" in the app
    // submenu so we match the standard macOS app-menu shape and bind Cmd+,
    // to it. Tauri's default app submenu is the first submenu in
    // `global_menu`.
    //
    // The title intentionally avoids the bare "Settings..." / "Preferences..."
    // strings: AppKit auto-binds those exact titles to predefined system
    // selectors at click time, which short-circuits Tauri's menu event
    // dispatcher. The Cmd+, accelerator goes through a different keystroke
    // path so it still fires the event, but the menu-item click is
    // swallowed. Using a non-magic title keeps the click flowing through
    // Tauri's normal `on_menu_event` listener.
    let settings_item = MenuItemBuilder::new("Readest Settings...")
        .id("open_settings")
        .accelerator("Cmd+,")
        .build(app)?;
    if let Some(app_menu_item) = global_menu.items()?.first() {
        if let Some(app_submenu) = app_menu_item.as_submenu() {
            app_submenu.insert(&settings_item, 1)?;
        }
    }

    global_menu.append(
        &SubmenuBuilder::new(app, "Help")
            .text("privacy_policy", "Privacy Policy")
            .separator()
            .text("report_issue", "Report An Issue...")
            .text("readest_help", "Readest Help")
            .build()?,
    )?;

    app.on_menu_event(|app, event| {
        handle_menu_event(app, &event);
    });

    Ok(())
}

pub fn handle_menu_event(app: &AppHandle, event: &MenuEvent) {
    // Temporary diagnostic to debug a menu-click vs accelerator discrepancy
    // for the Settings item. Remove once the menu wiring is settled.
    eprintln!("[menu] event id = {:?}", event.id());
    let opener = app.opener();
    if event.id() == "open_file" {
        handle_open_file(app);
    } else if event.id() == "open_settings" {
        // Broadcast to all windows; each window's frontend decides whether
        // to open its in-app Settings dialog based on its own state.
        let _ = app.emit("open-settings", ());
    } else if event.id() == "privacy_policy" {
        let _ = opener.open_url("https://readest.com/privacy-policy", None::<&str>);
    } else if event.id() == "report_issue" {
        let _ = opener.open_url("https://github.com/readest/readest/issues", None::<&str>);
    } else if event.id() == "readest_help" {
        let _ = opener.open_url("https://readest.com/support", None::<&str>);
    }
}

fn handle_open_file(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;

    let app_handle = app.clone();

    app.dialog()
        .file()
        .add_filter(
            "Files",
            &["epub", "pdf", "mobi", "azw", "azw3", "fb2", "cbz", "txt"],
        )
        .pick_file(move |file_path| {
            if let Some(path) = file_path {
                let payload = OpenFilesPayload {
                    files: vec![path.to_string()],
                };
                allow_file_in_scopes(&app_handle, vec![PathBuf::from(path.to_string())]);
                let _ = app_handle.emit("open-files", payload);
            }
        });
}
