# Actuator V&V test plan

Bench: leg actuator PCBA rev A on the leg CAN bus, flashed through ST-LINK.

| Test | Requirement | Pass criterion |
|---|---|---|
| T-03…T-05 | REQ-ACT-04 | Torque within 3 % from 0 to 60 °C |
| T-06, T-07 | REQ-ACT-07 | Current-loop BW ≥ 2 kHz, overshoot ≤ 5 % |
| T-08, T-09 | REQ-ACT-09 | Faults trip and recover |

![Gait sweep](../../AI/sim/gait/gait_sweep.png)
