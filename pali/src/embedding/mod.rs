mod candle;

use crate::error::MemoryError;

pub use self::candle::{CandleEmbeddingEngine, MODEL_ID};

/// Trait abstracting embedding backends so we can swap implementations
/// without changing calling code.
#[async_trait::async_trait]
pub trait EmbeddingBackend: Send + Sync {
    /// Embed a batch of texts, returning one vector per input.
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, MemoryError>;

    /// Convenience: embed a single text.
    async fn embed_one(&self, text: &str) -> Result<Vec<f32>, MemoryError> {
        let mut results = self.embed(&[text.to_string()]).await?;
        results
            .pop()
            .ok_or_else(|| MemoryError::Embedding("embedding returned no vectors".to_string()))
    }

    /// Number of dimensions produced by the model.
    fn dimensions(&self) -> usize;
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    struct EmptyBackend;

    #[async_trait::async_trait]
    impl EmbeddingBackend for EmptyBackend {
        async fn embed(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>, MemoryError> {
            Ok(Vec::new())
        }

        fn dimensions(&self) -> usize {
            3
        }
    }

    #[tokio::test]
    async fn embed_one_rejects_empty_backend_output() {
        assert_eq!(EmptyBackend.dimensions(), 3);
        let err = EmptyBackend
            .embed_one("text")
            .await
            .expect_err("a backend returning no vectors must fail");
        assert!(err.to_string().contains("no vectors"), "{err}");
    }
}
