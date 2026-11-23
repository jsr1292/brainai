//! The shell's own texts (tray menu, dialogs, update notices) in English and Spanish (Spain). Every sentence a person
//! can read from the shell is here, behind `tr(key)`. Which language is used: the owner's choice in the dashboard
//! (`<data folder>/ui-language.json`, `{"language":"auto|en|es"}`), and for `auto` (or a missing or broken file) the
//! operating system's language: `es*` is Spanish, anything else English. See docs/I18N.md.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Es,
}

/// What the owner chose: `auto`, `en` or `es`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Auto,
    En,
    Es,
}

/// Every key, with its English and Spanish text. `{name}` is replaced by `tr_with`.
pub const TABLE: &[(&str, &str, &str)] = &[
    // The tray menu.
    ("tray.open", "Open BrainAI", "Abrir BrainAI"),
    ("tray.login", "Start at login", "Iniciar al arrancar"),
    ("tray.quit", "Quit BrainAI", "Salir de BrainAI"),
    ("tray.update", "BrainAI is ready…", "BrainAI está listo…"),
    ("tray.restart_update", "Restart to update", "Reiniciar para actualizar"),
    ("tray.installing", "Installing update…", "Instalando la actualización…"),
    ("tray.downloading", "Downloading update… {percent}%", "Descargando la actualización… {percent} %"),
    ("tray.update_version", "BrainAI {version} is ready…", "BrainAI {version} está listo…"),
    // The two words for "this computer".
    ("computer.mac", "Mac", "Mac"),
    ("computer.pc", "PC", "ordenador"),
    // Removing BrainAI.
    ("remove.confirm", "Remove BrainAI from this {computer}? Your saved copy is at {folder}.", "¿Quitar BrainAI de este {computer}? Tu copia guardada está en {folder}."),
    ("remove.button", "Remove BrainAI", "Quitar BrainAI"),
    ("remove.done", "BrainAI is removed from this {computer}. Your saved copy is where the last page said.", "BrainAI se ha quitado de este {computer}. Tu copia guardada está donde decía la última página."),
    (
        "remove.not_saved",
        "BrainAI can't confirm a saved copy for this removal, so nothing was removed. Run Remove BrainAI again from Settings.",
        "BrainAI no puede confirmar que haya una copia guardada para esta eliminación, así que no se ha quitado nada. Vuelve a ejecutar Quitar BrainAI desde Ajustes.",
    ),
    (
        "remove.not_reopened",
        "BrainAI still can't save anything after the cancelled removal. Quit BrainAI and open it again.",
        "BrainAI sigue sin poder guardar nada tras cancelar la eliminación. Sal de BrainAI y vuelve a abrirlo.",
    ),
    ("remove.data_failed", "BrainAI could not delete its data folder {path} ({error}); delete it yourself.", "BrainAI no ha podido borrar su carpeta de datos {path} ({error}); bórrala tú."),
    ("remove.trash_failed", "BrainAI could not move itself to the Trash: drag {path} there yourself.", "BrainAI no ha podido moverse a la papelera: arrastra {path} hasta ella tú."),
    ("remove.drag_trash", "Drag BrainAI to the Trash to finish.", "Arrastra BrainAI a la papelera para terminar."),
    ("remove.uninstall_manual", "Uninstall BrainAI from Settings › Apps to finish.", "Desinstala BrainAI desde Configuración › Aplicaciones para terminar."),
    // Moving to a server.
    (
        "goodbye.confirm",
        "BrainAI is moving out of this Mac. Stop it now and stop starting it at login?\n\nYour data folder stays at {path}.",
        "BrainAI se va de este Mac. ¿Detenerlo ahora y dejar de iniciarlo al arrancar?\n\nTu carpeta de datos se queda en {path}.",
    ),
    ("goodbye.stop", "Stop BrainAI", "Detener BrainAI"),
    ("goodbye.not_now", "Not now", "Ahora no"),
    (
        "goodbye.done_win",
        "BrainAI is off and will not start at login. Uninstall BrainAI from Settings › Apps to finish.",
        "BrainAI está apagado y no se iniciará al arrancar. Desinstala BrainAI desde Configuración › Aplicaciones para terminar.",
    ),
    (
        "goodbye.done_mac",
        "BrainAI is off and will not start at login. Drag BrainAI from Applications to the Trash to finish.",
        "BrainAI está apagado y no se iniciará al arrancar. Arrastra BrainAI desde Aplicaciones a la papelera para terminar.",
    ),
    ("common.cancel", "Cancel", "Cancelar"),
    // The folder picker.
    ("folder.pick_title", "Choose a folder for the second copy", "Elige una carpeta para la segunda copia"),
    ("restore.pick_title", "Choose the folder with your saved copy", "Elige la carpeta con tu copia guardada"),
    // Start-up and running problems.
    (
        "err.vcredist",
        "BrainAI needs Microsoft's Visual C++ Redistributable (x64), which this computer does not have yet (missing: {missing}).\n\nInstall it from https://aka.ms/vs/17/release/vc_redist.x64.exe (it asks for an administrator), then open BrainAI again.",
        "BrainAI necesita el Redistributable de Visual C++ (x64) de Microsoft, que este ordenador aún no tiene (falta: {missing}).\n\nInstálalo desde https://aka.ms/vs/17/release/vc_redist.x64.exe (pide permisos de administrador) y vuelve a abrir BrainAI.",
    ),
    ("err.ports_all", "Every port BrainAI can use (3100 to 3199) is taken.", "Todos los puertos que BrainAI puede usar (del 3100 al 3199) están ocupados."),
    ("err.ports_all_short", "Every port BrainAI can use is taken.", "Todos los puertos que BrainAI puede usar están ocupados."),
    ("err.start", "BrainAI could not start its server: {error}.", "BrainAI no ha podido arrancar su servidor: {error}."),
    ("err.window", "BrainAI could not open its window: {error}.", "BrainAI no ha podido abrir su ventana: {error}."),
    ("start.finishing_update", "Finishing the update…", "Terminando la actualización…"),
    ("err.timeout", "BrainAI's server did not start.", "El servidor de BrainAI no ha arrancado."),
    ("err.squatter", "Another program keeps answering on BrainAI's port.", "Otro programa sigue respondiendo en el puerto de BrainAI."),
    ("err.keeps_stopping", "BrainAI's server keeps stopping.", "El servidor de BrainAI se sigue deteniendo."),
    ("err.crashed_start", "BrainAI stopped unexpectedly while starting.", "BrainAI se ha detenido inesperadamente al arrancar."),
    ("err.log_at", "{why}\n\nThe server's log is at {log}.", "{why}\n\nEl registro del servidor está en {log}."),
    (
        "err.restarted",
        "BrainAI's server stopped unexpectedly, so BrainAI started it again.\n\nThe log is at {log}.",
        "El servidor de BrainAI se ha detenido inesperadamente, así que BrainAI lo ha vuelto a arrancar.\n\nEl registro está en {log}.",
    ),
    (
        "err.port_changed",
        "Another program is using port {old}, so BrainAI now uses port {port}.\n\nApps you connected to http://localhost:{old} need connecting again: open Settings › Tools and press Connect.",
        "Otro programa está usando el puerto {old}, así que BrainAI usa ahora el puerto {port}.\n\nLas aplicaciones que conectaste a http://localhost:{old} hay que volver a conectarlas: abre Ajustes › Herramientas y pulsa Conectar.",
    ),
    // Updates.
    (
        "update.move_first",
        "BrainAI can't update itself while it runs from a disk image or a temporary copy. Move BrainAI to Applications and open it from there, or download the new version.",
        "BrainAI no puede actualizarse mientras se ejecuta desde una imagen de disco o una copia temporal. Mueve BrainAI a Aplicaciones y ábrelo desde allí, o descarga la versión nueva.",
    ),
    (
        "update.not_writable",
        "BrainAI can't replace its own files where it is installed, so download it again and install it over this one.",
        "BrainAI no puede sustituir sus propios archivos donde está instalado, así que descárgalo de nuevo e instálalo encima de este.",
    ),
    (
        "update.download",
        "The new version could not be downloaded. Check the internet connection and try again.",
        "No se ha podido descargar la versión nueva. Comprueba la conexión a internet e inténtalo de nuevo.",
    ),
    ("update.signature", "The download did not pass its signature check, so nothing was installed.", "La descarga no ha superado la comprobación de la firma, así que no se ha instalado nada."),
    ("update.install", "The new version could not be installed.", "No se ha podido instalar la versión nueva."),
    ("update.backup", "A backup could not be made, so nothing was changed: {said}", "No se ha podido hacer una copia de seguridad, así que no se ha cambiado nada: {said}"),
    ("update.backup_unfinished", "The backup did not finish.", "La copia de seguridad no ha terminado."),
];

fn lookup(lang: Lang, key: &str) -> &'static str {
    match TABLE.iter().find(|(k, _, _)| *k == key) {
        Some((_, en, es)) => match lang {
            Lang::En => en,
            Lang::Es => es,
        },
        None => {
            debug_assert!(false, "unknown shell text key {key}");
            "BrainAI"
        }
    }
}

/// The text of `key` in `lang`, with each `{name}` replaced.
pub fn tr_in_with(lang: Lang, key: &str, params: &[(&str, &str)]) -> String {
    let mut text = lookup(lang, key).to_string();
    for (name, value) in params {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

/// What the file says: a missing, unreadable or broken file, and any value but `en` or `es`, is `auto`.
pub fn parse_choice(content: Option<&str>) -> Choice {
    let value = content.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
    match value.as_ref().and_then(|v| v.get("language")).and_then(|l| l.as_str()) {
        Some("en") => Choice::En,
        Some("es") => Choice::Es,
        _ => Choice::Auto,
    }
}

/// The operating system's language: anything starting with `es` (`es-ES`, `es_MX`, `es`) is Spanish.
pub fn from_system(locale: Option<&str>) -> Lang {
    let l = locale.unwrap_or("").trim().to_ascii_lowercase();
    if l == "es" || l.starts_with("es-") || l.starts_with("es_") {
        Lang::Es
    } else {
        Lang::En
    }
}

/// The owner's choice wins; `auto` follows the system.
pub fn resolve(file: Option<&str>, system_locale: Option<&str>) -> Lang {
    match parse_choice(file) {
        Choice::En => Lang::En,
        Choice::Es => Lang::Es,
        Choice::Auto => from_system(system_locale),
    }
}

/// The system's preferred language (`es-ES`), if it says.
pub fn system_locale() -> Option<String> {
    sys_locale::get_locale()
}

static DATA: OnceLock<PathBuf> = OnceLock::new();
static CURRENT: AtomicU8 = AtomicU8::new(0);

fn read_lang(data: &Path) -> Lang {
    resolve(std::fs::read_to_string(data.join("ui-language.json")).ok().as_deref(), system_locale().as_deref())
}

/// Remembers the server's data folder (where ui-language.json is) and reads the language from it.
pub fn init(data: PathBuf) {
    let lang = read_lang(&data);
    let _ = DATA.set(data);
    CURRENT.store(lang as u8, Ordering::SeqCst);
}

/// Reads the file again (the owner may have changed the language in the dashboard). True when the language changed.
pub fn refresh() -> bool {
    let Some(data) = DATA.get() else { return false };
    let lang = read_lang(data) as u8;
    CURRENT.swap(lang, Ordering::SeqCst) != lang
}

pub fn current() -> Lang {
    if CURRENT.load(Ordering::SeqCst) == Lang::Es as u8 {
        Lang::Es
    } else {
        Lang::En
    }
}

/// The text of `key` in the language in use now (English until `init`).
pub fn tr(key: &str) -> String {
    tr_in_with(current(), key, &[])
}

pub fn tr_with(key: &str, params: &[(&str, &str)]) -> String {
    tr_in_with(current(), key, params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placeholders(s: &str) -> Vec<String> {
        let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split('}').next()).map(String::from).collect();
        v.sort();
        v
    }

    #[test]
    fn every_key_has_both_languages_and_the_same_placeholders() {
        let mut seen = std::collections::HashSet::new();
        for (key, en, es) in TABLE {
            assert!(seen.insert(*key), "{key} twice");
            assert!(!en.is_empty() && !es.is_empty(), "{key} has an empty text");
            assert_ne!(*en, "", "{key}");
            assert_eq!(placeholders(en), placeholders(es), "{key}: placeholders differ");
        }
        assert_eq!(tr_in_with(Lang::Es, "tray.open", &[]), "Abrir BrainAI");
        assert_eq!(tr_in_with(Lang::Es, "tray.login", &[]), "Iniciar al arrancar");
        assert_eq!(tr_in_with(Lang::En, "tray.open", &[]), "Open BrainAI");
    }

    #[test]
    fn params_are_filled_in() {
        assert_eq!(tr_in_with(Lang::Es, "tray.update_version", &[("version", "1.7.0")]), "BrainAI 1.7.0 está listo…");
        assert_eq!(tr_in_with(Lang::En, "err.start", &[("error", "boom")]), "BrainAI could not start its server: boom.");
    }

    #[test]
    fn auto_follows_the_system_language() {
        assert_eq!(resolve(None, Some("es-ES")), Lang::Es);
        assert_eq!(resolve(Some(r#"{"language":"auto"}"#), Some("es_MX")), Lang::Es);
        assert_eq!(resolve(Some(r#"{"language":"auto"}"#), Some("es")), Lang::Es);
        assert_eq!(resolve(Some(r#"{"language":"auto"}"#), Some("en-GB")), Lang::En);
        assert_eq!(resolve(Some(r#"{"language":"auto"}"#), Some("fr-FR")), Lang::En);
        assert_eq!(resolve(Some(r#"{"language":"auto"}"#), Some("est-EE")), Lang::En, "not Spanish");
        assert_eq!(resolve(Some(r#"{"language":"auto"}"#), None), Lang::En);
    }

    #[test]
    fn the_owners_choice_overrides_the_system() {
        assert_eq!(resolve(Some(r#"{"language":"en","updatedAt":"2026-11-19T10:00:00Z"}"#), Some("es-ES")), Lang::En);
        assert_eq!(resolve(Some(r#"{"language":"es"}"#), Some("en-US")), Lang::Es);
    }

    #[test]
    fn a_missing_or_broken_file_is_auto() {
        assert_eq!(resolve(None, Some("es-ES")), Lang::Es);
        assert_eq!(resolve(Some(""), Some("es-ES")), Lang::Es);
        assert_eq!(resolve(Some("{not json"), Some("es-ES")), Lang::Es);
        assert_eq!(resolve(Some(r#"{"language":"fr"}"#), Some("es-ES")), Lang::Es);
        assert_eq!(resolve(Some(r#"{"language":7}"#), Some("en-US")), Lang::En);
        assert_eq!(resolve(Some("[]"), Some("en-US")), Lang::En);
    }

    #[test]
    fn the_file_is_read_from_the_data_folder() {
        let dir = std::env::temp_dir().join(format!("brainai-lang-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_lang(&dir), from_system(system_locale().as_deref()), "no file: auto");
        std::fs::write(dir.join("ui-language.json"), r#"{"language":"es"}"#).unwrap();
        assert_eq!(read_lang(&dir), Lang::Es);
        std::fs::write(dir.join("ui-language.json"), r#"{"language":"en"}"#).unwrap();
        assert_eq!(read_lang(&dir), Lang::En);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn before_init_the_shell_speaks_english() {
        assert_eq!(current(), Lang::En);
        assert_eq!(tr("tray.quit"), "Quit BrainAI");
    }
}
