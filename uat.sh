#!/bin/bash

# uat.sh — the human UAT checklist.
# Lists every task the headless agent CANNOT fully verify (headless_verifiable=false),
# and whether the agent has built it yet. Run after (or during) an overnight Ralph run.
#
#   ./uat.sh            # list UAT tasks from prd.json
#   PRD_FILE=x ./uat.sh

prd="${PRD_FILE:-prd.json}"
if [ ! -f "$prd" ]; then echo "PRD not found: $prd"; exit 1; fi

node -e "
const fs=require('fs');
const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const uat=a.map((t,i)=>({n:i+1,...t})).filter(t=>t.headless_verifiable===false);
const built=uat.filter(t=>t.passes).length;
const doneAll=a.filter(t=>t.passes).length;
console.log('');
console.log('  UAT CHECKLIST — '+uat.length+' tasks need a human to confirm');
console.log('  ('+built+' built & awaiting review, '+(uat.length-built)+' not built yet)');
console.log('  overall build progress: '+doneAll+'/'+a.length);
console.log('');
uat.forEach(t=>console.log('  '+(t.passes?'[review ✓built]':'[pending    ]')+'  #'+t.n+'  ['+t.category+']  '+t.description));
console.log('');
" "$prd"
