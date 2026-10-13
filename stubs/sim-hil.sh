#!/bin/sh
# Simulated HIL test plan for the stub environment (no hardware). Speaks the hub's HIL line protocol:
#   ##hil plan <count>
#   ##hil test <id> <req> <name…>      (test starts)
#   ##hil pass|fail|skip <id> <ms> [reason…]
# Any other line is log output. HIL_ONLY="T-03,T-07" limits the run (used by "re-run failed").
TESTS="T-01|REQ-ACT-01|Flash fw 0.7.3 via ST-LINK
T-02|REQ-ACT-02|CAN heartbeat on 0x101-0x103
T-03|REQ-ACT-04|Torque hold 0 C
T-04|REQ-ACT-04|Torque hold 25 C
T-05|REQ-ACT-04|Torque hold 60 C
T-06|REQ-ACT-07|Current loop step response
T-07|REQ-ACT-07|Overshoot <= 5 %
T-08|REQ-ACT-09|Fault: over-current trip
T-09|REQ-ACT-09|Fault: CAN bus-off recovery
T-10|REQ-ACT-11|Encoder index on power-up
T-11|REQ-ACT-12|Thermal derate above 55 C
T-12|REQ-ACT-13|Safe state on E-stop"
count=$(echo "$TESTS" | while IFS='|' read -r id req name; do if [ -z "$HIL_ONLY" ] || echo ",$HIL_ONLY," | grep -q ",$id,"; then echo x; fi; done | wc -l)
echo "##hil plan $count"
echo "bench: leg actuator PCBA rev A on leg CAN bus (simulated)"
echo "$TESTS" | while IFS='|' read -r id req name; do
  if [ -n "$HIL_ONLY" ] && ! echo ",$HIL_ONLY," | grep -q ",$id,"; then continue; fi
  echo "##hil test $id $req $name"
  echo "  $id: running $name"
  sleep "${HIL_STEP_S:-0.4}"
  if [ "$id" = "T-07" ] && [ -z "$HIL_FIXED" ]; then
    echo "  $id: overshoot 7.9 % > 5 %"
    echo "##hil fail $id 400 overshoot 7.9 % > 5 %"
  else
    echo "##hil pass $id 400"
  fi
done
echo "done"
