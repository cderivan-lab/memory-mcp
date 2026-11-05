/// Unit tests for the types module - validates edge cases and ensures comprehensive coverage.
use pali::types::{Memory, MemoryMetadata, MemoryName, MemoryRef, Scope, ScopePath};

/// Test ScopePath newtype edge cases
mod scope_path_tests {
    use super::*;

    #[test]
    fn test_scope_path_new_valid() {
        let path = ScopePath::new("test-proj").unwrap();
        assert_eq!(path.as_str(), "test-proj");
    }

    #[test]
    fn test_scope_path_new_empty() {
        let result = ScopePath::new("");
        assert!(result.is_err());
    }

    #[test]
    fn test_scope_path_new_absolute() {
        let result = ScopePath::new("/absolute/path");
        assert!(result.is_err());
    }

    #[test]
    fn test_scope_path_new_deep() {
        // Create a path with more than 10 components
        let many_components = "a/b/c/d/e/f/g/h/i/j/k";
        let result = ScopePath::new(many_components);
        assert!(result.is_err());
    }

    #[test]
    fn test_scope_path_new_dot_dots() {
        let result = ScopePath::new("a/../b");
        assert!(result.is_err());
    }

    #[test]
    fn test_scope_path_new_dot_prefix() {
        let result = ScopePath::new(".hidden");
        assert!(result.is_err());
    }

    #[test]
    fn test_scope_path_new_invalid_chars() {
        let result = ScopePath::new("a/b c");
        assert!(result.is_err());
    }

    #[test]
    fn test_scope_path_new_with_underscores() {
        let path = ScopePath::new("my_project_valid-name_v2").unwrap();
        assert_eq!(path.as_str(), "my_project_valid-name_v2");
    }
}

/// Test MemoryName edge cases
mod memory_name_tests {
    use super::*;

    #[test]
    fn test_memory_name_new_valid() {
        let name = MemoryName::new("test-name").unwrap();
        assert_eq!(name.as_str(), "test-name");
    }

    #[test]
    fn test_memory_name_new_empty() {
        let result = MemoryName::new("");
        assert!(result.is_err());
    }
}

/// Test MemoryRef edge cases
mod memory_ref_tests {
    use super::*;

    #[test]
    fn test_memory_ref_new_valid() {
        let scope = Scope::Root;
        let name = MemoryName::new("test-name").unwrap();
        let ref_ = MemoryRef::new(scope, name);
        let qualified = ref_.qualified_path();
        assert!(qualified.contains("test-name"));
    }
}

/// Test Memory edge cases
mod memory_tests {
    use super::*;

    #[test]
    fn test_memory_new_valid() {
        let scope = Scope::Root;
        let _name = MemoryName::new("test-mem").unwrap();
        let metadata = MemoryMetadata::new(scope, vec![], None);
        let memory = Memory::new("test-name", "content", metadata).unwrap();
        assert_eq!(memory.name.as_str(), "test-name");
    }

    #[test]
    fn test_memory_new_empty_name() {
        let scope = Scope::Root;
        let metadata = MemoryMetadata::new(scope, vec![], None);
        let result = Memory::new("", "content", metadata);
        assert!(result.is_err());
    }
}

/// Test MemoryMetadata edge cases
mod memory_metadata_tests {
    use super::*;

    #[test]
    fn test_memory_metadata_new_root() {
        let scope = Scope::Root;
        let metadata = MemoryMetadata::new(scope.clone(), vec![], None);
        assert_eq!(metadata.scope, scope);
        assert_eq!(metadata.tags.len(), 0);
    }

    #[test]
    fn test_memory_metadata_with_tags() {
        let scope = Scope::Root;
        let metadata =
            MemoryMetadata::new(scope, vec!["tag1".to_string(), "tag2".to_string()], None);
        assert_eq!(metadata.tags.len(), 2);
        assert!(metadata.tags.contains(&"tag1".to_string()));
        assert!(metadata.tags.contains(&"tag2".to_string()));
    }
}

/// Test Scope edge cases
mod scope_tests {
    use super::*;

    #[test]
    fn test_scope_root() {
        let scope = Scope::Root;
        assert_eq!(format!("{:?}", scope), "Root");
    }

    #[test]
    fn test_scope_path() {
        let scope = Scope::Path(ScopePath::new("test-proj").unwrap());
        assert!(matches!(scope, Scope::Path(_)));
    }
}

/// Test ValidatedString trait implementations
mod validated_tests {
    use super::*;

    #[test]
    fn test_validated_string_trait() {
        // Test that the trait methods work correctly
        let path = ScopePath::new("valid-path").unwrap();
        let _str: &str = path.as_str();
        assert_eq!(_str, "valid-path");
    }
}
