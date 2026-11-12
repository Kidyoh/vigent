// The version is package.json's, so the npm package and the binary always say the same thing.
fn main() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = std::fs::read_to_string(&manifest).expect("package.json next to crates/");
    let version = text
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .expect("a version in package.json");
    println!("cargo:rustc-env=VIGENT_VERSION={version}");
}
