use std::{sync::mpsc, thread};
use tauri::async_runtime;

type Operation = Box<dyn FnOnce() + Send>;

/// Runs complete native lifecycle operations in admission order off the UI thread.
pub struct RuntimeQueue(mpsc::Sender<Operation>);

impl Default for RuntimeQueue {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<Operation>();
        thread::spawn(move || {
            for operation in receiver {
                operation();
            }
        });
        Self(sender)
    }
}

impl RuntimeQueue {
    pub fn enqueue(&self, operation: impl FnOnce() + Send + 'static) -> Result<(), String> {
        self.0
            .send(Box::new(operation))
            .map_err(|_| "Desktop runtime worker is unavailable.".to_string())
    }

    pub async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (sender, mut receiver) = async_runtime::channel(1);
        self.enqueue(move || {
            // A dropped WebView response must not cancel an admitted runtime operation.
            let _ = sender.try_send(operation());
        })?;
        receiver
            .recv()
            .await
            .ok_or_else(|| "Desktop runtime operation ended without a result.".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc::RecvTimeoutError, time::Duration};

    #[test]
    fn tray_stop_waits_for_the_in_flight_launch_to_publish_its_result() {
        let queue = RuntimeQueue::default();
        let (events, observed) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let timeout = Duration::from_secs(5);
        let launch_events = events.clone();
        queue
            .enqueue(move || {
                launch_events.send("launch entered").unwrap();
                held.recv_timeout(timeout).unwrap();
                launch_events.send("launch published").unwrap();
            })
            .unwrap();
        assert_eq!(observed.recv_timeout(timeout), Ok("launch entered"));

        queue
            .enqueue(move || events.send("stop completed").unwrap())
            .unwrap();
        assert_eq!(observed.try_recv(), Err(mpsc::TryRecvError::Empty));
        release.send(()).unwrap();

        assert_eq!(observed.recv_timeout(timeout), Ok("launch published"));
        assert_eq!(observed.recv_timeout(timeout), Ok("stop completed"));
        assert_eq!(
            observed.recv_timeout(timeout),
            Err(RecvTimeoutError::Disconnected)
        );
    }
}
