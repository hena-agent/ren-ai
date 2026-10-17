fn main() {
    let source = "../../node_modules/.cache/ren-rustpush/matrix/pkg/rustpushgo/src/hardware_info.m";
    println!("cargo:rerun-if-changed={source}");
    cc::Build::new()
        .file(source)
        .flag("-fobjc-arc")
        .compile("hardware_info");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=IOKit");
    println!("cargo:rustc-link-lib=framework=DiskArbitration");
}
