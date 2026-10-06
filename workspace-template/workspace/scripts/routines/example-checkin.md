# Routine: example check-in

A local routine prompt. A file here overrides the routine of the same name stored on the coaching
server; delete this example once you have real routines. Most routines need no file here at all:
`run_routine.sh <name>` runs the server's stored routine `<name>`.

1. Call `start_session` with scope `items` and anchor today's date on a tool that reports the
   user's local date.
2. If an open item is overdue, tell the user in two sentences which one and what it needs: send it
   with `notify_user` when that tool exists, otherwise write it as a journal entry.
3. If nothing is overdue, report nothing.
