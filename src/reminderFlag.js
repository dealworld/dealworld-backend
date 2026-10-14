/**
 * Global kill switch for every automated reminder email. Off unless the env
 * var is explicitly "true", and read at send time (not at boot) so a job that
 * is already scheduled still can't send once the flag is off.
 */
function reminderEmailsEnabled() {
  return String(process.env.REMINDER_EMAILS_ENABLED || "").toLowerCase() === "true";
}

function logSkippedReminder(what) {
  console.log(`[reminders] REMINDER_EMAILS_ENABLED is off, skipped: ${what}`);
}

module.exports = { reminderEmailsEnabled, logSkippedReminder };
