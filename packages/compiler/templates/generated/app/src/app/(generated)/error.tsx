"use client";

// Production strips server error messages, so this can't tell a cold start from other failures. The cold start
// (Aurora resuming after auto-pause) is the common one, and retrying is the right move for both.
export default function PageError() {
  return (
    <main>
      <h1>This page didn&apos;t load</h1>
      <p>If the app hasn&apos;t been used for a while, it is starting up. Try again in a few seconds.</p>
      <button type="button" onClick={() => location.reload()}>
        Try again
      </button>
    </main>
  );
}
