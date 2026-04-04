use crate::constants::{MANIFEST_FILE_NAME, OPENPTL_FILE_NAME, PROFILE_FILE_NAME};

#[test]
fn should_keep_vault_export_file_names_in_bin_format() {
    for file in [OPENPTL_FILE_NAME, PROFILE_FILE_NAME, MANIFEST_FILE_NAME] {
        assert!(file.ends_with(".bin"));
    }
}
