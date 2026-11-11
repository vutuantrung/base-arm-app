# @arm/supervisor-host

Composition root for the ARM Supervisor Management daemon. Owns module wiring and ordered startup/shutdown; it never owns a child's business state or PID. See `docs/PHASE_R6_COMPOSITION_ROOT_AND_ENFORCEMENT.md`.
