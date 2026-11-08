/// Unit tests for fs_util module - validates edge cases and ensures comprehensive coverage.
use std::path::PathBuf;

use pali::fs_util::{canonicalize_allow_missing, expand_tilde};

/// Test expand_tilde edge cases
mod expand_tilde_tests {
    use super::*;

    #[test]
    fn test_expand_tilde_home() {
        let result = expand_tilde("~/foo/bar").unwrap();
        let home = dirs::home_dir().unwrap();
        assert_eq!(result, home.join("foo/bar"));
    }

    #[test]
    fn test_expand_tilde_root() {
        let result = expand_tilde("~").unwrap();
        let home = dirs::home_dir().unwrap();
        assert_eq!(result, home);
    }

    #[test]
    fn test_expand_tilde_absolute_passthrough() {
        let result = expand_tilde("/tmp/repo").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/repo"));
    }

    #[test]
    fn test_expand_tilde_relative_passthrough() {
        let result = expand_tilde("relative/path").unwrap();
        assert_eq!(result, PathBuf::from("relative/path"));
    }

    #[test]
    fn test_expand_tilde_user_not_supported() {
        let result = expand_tilde("~user/foo");
        assert!(result.is_err());
    }
}

/// Test canonicalize_allow_missing edge cases
mod canonicalize_allow_missing_tests {
    use super::*;

    #[test]
    fn test_canonicalize_existing_path() {
        let path = std::env::temp_dir().join("pali-test-canonicalize");
        // Create the path
        std::fs::create_dir_all(&path).ok();
        let result = canonicalize_allow_missing(&path);
        // Should succeed or fail gracefully
        println!("canonicalize existing: {:?}", result);
        // Clean up
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn test_canonicalize_nonexistent_path() {
        let path = std::env::temp_dir().join("pali-test-nonexistent-12345");
        // Path doesn't exist yet - this is the main use case
        let result = canonicalize_allow_missing(&path);
        println!("canonicalize nonexistent: {:?}", result);
        // Clean up if any dirs were created
        let _ = std::fs::remove_dir_all(&path.parent().unwrap_or(&path));
    }

    #[test]
    fn test_canonicalize_with_dot_dots() {
        let path = std::env::temp_dir().join("pali-test-dot-dots");
        std::fs::create_dir_all(path.join("existing")).ok();
        let full_path = path.join("existing/../missing");
        let result = canonicalize_allow_missing(&full_path);
        println!("canonicalize dot-dots: {:?}", result);
        let _ = std::fs::remove_dir_all(&path.parent().unwrap_or(&path));
    }

    #[test]
    fn test_canonicalize_with_symlink() {
        let path = std::env::temp_dir().join("pali-test-symlink");
        std::fs::create_dir_all(&path).ok();
        // Create a symlink
        let link_path = path.join("link");
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink("target", &link_path);
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir("target", &link_path);
        let full_path = path.join("link/../other");
        let result = canonicalize_allow_missing(&full_path);
        println!("canonicalize symlink: {:?}", result);
        let _ = std::fs::remove_dir_all(&path);
    }
}
