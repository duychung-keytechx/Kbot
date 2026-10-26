use std::fmt::Write as _;
use std::path::Path;
use std::{env, fs};

fn main() {
    embed_migrations();
    tauri_build::build()
}

/// Embeds every `migrations/NNNN_name.sql` into the binary (see `src/migrate.rs`),
/// so adding a migration is just dropping a new file into that folder.
fn embed_migrations() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut migrations = Vec::new();
    for entry in fs::read_dir(&dir).expect("read migrations dir") {
        let path = entry.expect("read migrations entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let file = path.file_name().unwrap().to_str().expect("utf-8 file name").to_string();
        let (version, name) = file
            .trim_end_matches(".sql")
            .split_once('_')
            .and_then(|(v, n)| Some((v.parse::<i64>().ok()?, n.to_string())))
            .unwrap_or_else(|| panic!("migration `{file}` must be named NNNN_description.sql"));
        println!("cargo:rerun-if-changed={}", path.display());
        migrations.push((version, name, path));
    }
    migrations.sort_by_key(|(version, ..)| *version);
    for pair in migrations.windows(2) {
        assert!(pair[0].0 != pair[1].0, "duplicate migration version {}", pair[0].0);
    }

    let mut out = String::from("&[\n");
    for (version, name, path) in &migrations {
        writeln!(
            out,
            "    Migration {{ version: {version}, name: {name:?}, sql: include_str!({:?}) }},",
            path.display().to_string()
        )
        .unwrap();
    }
    out.push(']');
    let out_dir = env::var("OUT_DIR").unwrap();
    fs::write(Path::new(&out_dir).join("migrations.rs"), out).unwrap();
}
