#!/bin/bash
cd /home/kavia/workspace/code-generation/focus-timer-and-sound-mixer-219728-219742/focus_music_frontend
npm run build
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
   exit 1
fi

