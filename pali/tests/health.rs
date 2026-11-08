/// Unit tests for health module - validates edge cases and ensures comprehensive coverage.
use pali::health::{HealthRegistry, SubsystemReporter};

/// Test SubsystemStatus edge cases
mod subsystem_status_tests {
    use super::*;

    #[test]
    fn test_subsystem_status_initial() {
        // Use SubsystemReporter to get initial state instead of private constructor
        let reporter = SubsystemReporter::new();
        let status = reporter.load();
        assert!(!status.healthy);
        assert_eq!(status.reason, Some("not yet checked"));
        assert!(status.last_success.is_none());
        assert!(status.last_failure.is_none());
    }
}

/// Test SubsystemReporter edge cases
mod subsystem_reporter_tests {
    use super::*;

    #[test]
    fn test_subsystem_reporter_new() {
        let reporter = SubsystemReporter::new();
        let status = reporter.load();
        assert!(!status.healthy);
        assert_eq!(status.reason, Some("not yet checked"));
    }

    #[test]
    fn test_subsystem_reporter_report_ok() {
        let reporter = SubsystemReporter::new();
        reporter.report_ok();
        let status = reporter.load();
        assert!(status.healthy);
        assert!(status.reason.is_none());
        assert!(status.last_success.is_some());
    }

    #[test]
    fn test_subsystem_reporter_report_err() {
        let reporter = SubsystemReporter::new();
        reporter.report_err("test error");
        let status = reporter.load();
        assert!(!status.healthy);
        assert_eq!(status.reason, Some("test error"));
        assert!(status.last_failure.is_some());
    }

    #[test]
    fn test_subsystem_reporter_clone_shares_state() {
        let reporter = SubsystemReporter::new();
        let reporter2 = reporter.clone();
        reporter.report_ok();
        let status = reporter2.load();
        assert!(status.healthy); // Clone shares state
    }

    #[test]
    fn test_subsystem_reporter_load_multiple_times() {
        let reporter = SubsystemReporter::new();
        reporter.report_err("first error");
        let status1 = reporter.load();
        reporter.report_ok();
        let status2 = reporter.load();
        assert!(!status1.healthy);
        assert!(status2.healthy);
    }
}

/// Test HealthRegistry edge cases
mod health_registry_tests {
    use super::*;

    #[test]
    fn test_health_registry_new() {
        let registry = HealthRegistry::new();
        assert!(!registry.git.load().healthy);
        assert!(!registry.embedding.load().healthy);
        assert!(!registry.vector_index.load().healthy);
        assert!(!registry.sync.load().healthy);
    }

    #[test]
    fn test_health_registry_report_and_load() {
        let registry = HealthRegistry::new();
        registry.git.report_ok();
        registry.embedding.report_err("embed fail");

        let git_status = registry.git.load();
        let embed_status = registry.embedding.load();
        let vec_status = registry.vector_index.load();
        let sync_status = registry.sync.load();

        assert!(git_status.healthy);
        assert!(!embed_status.healthy);
        // vector_index and sync start as "not yet checked" (unhealthy)
        assert!(!vec_status.healthy);
        assert!(!sync_status.healthy);
    }
}
