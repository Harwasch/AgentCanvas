#!/bin/sh
# stub nvidia-smi: one simulated 24 GB GPU; usage drifts with time so the machine node moves.
# Only the query the hub uses is supported:
#   nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
s=$(( $(date +%s) % 60 ))
util=$(( 30 + s ))
used=$(( 6000 + s * 40 ))
[ -f "$HOME/.sim/gpu-load" ] && used=$(( used + $(cat "$HOME/.sim/gpu-load") ))
echo "NVIDIA RTX A5000 (simulated), $util, $used, 24564"
