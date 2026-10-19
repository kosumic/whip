//! Reproduce the notices for the exact bundled syntax definitions without network access.
fn main() {
    print!("{}", two_face::acknowledgement::url());
    println!("\n\n{}", two_face::acknowledgement::listing().to_md());
}
