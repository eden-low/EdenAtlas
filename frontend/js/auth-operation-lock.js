// One canonical single-flight state for every Login-page auth action. A navigation handoff is
// terminal for this page: once completing, release() deliberately cannot make it actionable
// again. The visual navigation delay is therefore never the duplicate-submission boundary.

export const AUTH_OPERATION_PHASE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  COMPLETING: "completing",
});

export function createAuthOperationLock(onChange = () => {}) {
  let phase = AUTH_OPERATION_PHASE.IDLE;
  let operation = null;

  function notify() {
    onChange(Object.freeze({ phase, operation }));
  }

  return Object.freeze({
    begin(name) {
      if (phase !== AUTH_OPERATION_PHASE.IDLE) return false;
      phase = AUTH_OPERATION_PHASE.RUNNING;
      operation = String(name || "auth");
      notify();
      return true;
    },
    release() {
      if (phase !== AUTH_OPERATION_PHASE.RUNNING) return false;
      phase = AUTH_OPERATION_PHASE.IDLE;
      operation = null;
      notify();
      return true;
    },
    handoffToNavigation() {
      if (phase === AUTH_OPERATION_PHASE.COMPLETING) return false;
      phase = AUTH_OPERATION_PHASE.COMPLETING;
      operation = operation || "navigation";
      notify();
      return true;
    },
    isActive() {
      return phase !== AUTH_OPERATION_PHASE.IDLE;
    },
    snapshot() {
      return Object.freeze({ phase, operation });
    },
  });
}
