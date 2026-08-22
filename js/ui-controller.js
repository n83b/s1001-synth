/**
 * Roland AIRA Compact S-1 Tweak Synth - UI & Interaction Controller
 * Rotary knobs, 7-segment LED screen, OLED oscilloscope, OSC Draw canvas, MIDI & Key bindings
 */

class S1UIController {
  constructor(audioEngine, sequencer) {
    this.engine = audioEngine;
    this.seq = sequencer;

    this.currentOctave = 0; // Center octave: 0 (range -3 to +3, 0 = C4/60)
    this.displayTimeout = null;

    // Active playing notes
    this.pressedKeys = new Set();

    // DOM Elements
    this.initElements();
    this.initKnobs();
    this.initModeButtons();
    this.initTransport();
    this.initStepKeys();
    this.initOscilloscope();
    this.initDrawModal();
    this.initMidi();
    this.initRecorder();
  }

  initElements() {
    this.seg1 = document.getElementById('seg-1');
    this.seg2 = document.getElementById('seg-2');
    this.seg3 = document.getElementById('seg-3');
    this.seg4 = document.getElementById('seg-4');
    this.subInfo = document.getElementById('screen-subinfo');
    this.octaveDisplay = document.getElementById('octave-display');
    this.scopeCanvas = document.getElementById('scope-canvas');
    this.presetSelect = document.getElementById('preset-select');
  }

  // =========================================================================
  // 7-SEGMENT LED DISPLAY FORMATTER
  // =========================================================================
  setDisplay(text, subtext = '') {
    if (!this.seg1 || !this.seg2 || !this.seg3 || !this.seg4) return;
    const chars = (text + '    ').substring(0, 4).toUpperCase();
    this.seg1.textContent = chars[0];
    this.seg2.textContent = chars[1];
    this.seg3.textContent = chars[2];
    this.seg4.textContent = chars[3];

    if (subtext && this.subInfo) {
      this.subInfo.textContent = subtext.toUpperCase();
    }

    if (this.displayTimeout) clearTimeout(this.displayTimeout);
    this.displayTimeout = setTimeout(() => {
      this.seg1.textContent = 'S';
      this.seg2.textContent = '-';
      this.seg3.textContent = '0';
      this.seg4.textContent = '1';
      if (this.subInfo) {
        this.subInfo.textContent = `READY • TEMPO ${this.engine.params.tempo}`;
      }
    }, 2500);
  }

  formatOctaveText(oct) {
    if (oct > 0) return `OCT +${oct}`;
    if (oct < 0) return `OCT ${oct}`;
    return `OCT 0`;
  }

  formatOctaveDisplay(oct) {
    if (oct > 0) return `OC+${oct}`;
    if (oct < 0) return `OC-${Math.abs(oct)}`;
    return `OC 0`;
  }

  setOctave(newOct, updateScreen = false) {
    this.currentOctave = Math.max(-3, Math.min(3, newOct));
    if (this.octaveDisplay) {
      this.octaveDisplay.textContent = this.formatOctaveText(this.currentOctave);
    }
    if (updateScreen) {
      const disp = this.formatOctaveDisplay(this.currentOctave);
      const sub = this.currentOctave > 0 ? `OCTAVE +${this.currentOctave}` : (this.currentOctave < 0 ? `OCTAVE ${this.currentOctave}` : 'OCTAVE 0 (MIDDLE C)');
      this.setDisplay(disp, sub);
    }
    this.updateNoteKeysHighlight();
  }

  // =========================================================================
  // ROTARY KNOB CONTROLLER
  // =========================================================================
  initKnobs() {
    const knobs = document.querySelectorAll('.rotary-knob');

    knobs.forEach((knob) => {
      const paramName = knob.dataset.param;
      const min = parseFloat(knob.dataset.min);
      const max = parseFloat(knob.dataset.max);
      const def = parseFloat(knob.dataset.default);
      const isExp = knob.dataset.curve === 'exp';
      const label = knob.dataset.label || paramName;

      const initialVal = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
      this.updateKnobVisual(knob, initialVal, min, max, isExp);

      let startY = 0;
      let startVal = initialVal;
      let isDragging = false;

      const onPointerDown = (e) => {
        this.engine.ensureAudioContext();
        isDragging = true;
        startY = e.clientY || (e.touches && e.touches[0].clientY);
        startVal = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
        document.body.style.cursor = 'ns-resize';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
      };

      const onPointerMove = (e) => {
        if (!isDragging) return;
        const currentY = e.clientY || (e.touches && e.touches[0].clientY);
        const deltaY = startY - currentY;
        const speed = e.shiftKey ? 0.0015 : 0.006;

        let normVal;
        if (isExp) {
          normVal = Math.log(startVal / min) / Math.log(max / min);
        } else {
          normVal = (startVal - min) / (max - min);
        }

        normVal = Math.max(0, Math.min(1, normVal + deltaY * speed));

        let newVal;
        if (isExp) {
          newVal = min * Math.pow(max / min, normVal);
        } else {
          newVal = min + normVal * (max - min);
        }

        if (knob.dataset.step && parseFloat(knob.dataset.step) >= 1) {
          newVal = Math.round(newVal);
        }

        this.engine.setParam(paramName, newVal);
        this.seq.recordMotion(paramName, newVal);
        this.updateKnobVisual(knob, newVal, min, max, isExp);

        let displayStr = '';
        if (newVal >= 1000) displayStr = (newVal / 1000).toFixed(1) + 'K';
        else if (newVal >= 100) displayStr = Math.round(newVal).toString();
        else if (newVal >= 10) displayStr = newVal.toFixed(1);
        else displayStr = newVal.toFixed(2);

        this.setDisplay(displayStr, `${label}: ${displayStr}`);
      };

      const onPointerUp = () => {
        isDragging = false;
        document.body.style.cursor = 'default';
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      knob.addEventListener('pointerdown', onPointerDown);

      knob.addEventListener('wheel', (e) => {
        this.engine.ensureAudioContext();
        e.preventDefault();
        const cur = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
        const step = (max - min) * 0.025 * (e.deltaY < 0 ? 1 : -1);
        const newVal = Math.max(min, Math.min(max, cur + step));
        this.engine.setParam(paramName, newVal);
        this.seq.recordMotion(paramName, newVal);
        this.updateKnobVisual(knob, newVal, min, max, isExp);
        this.setDisplay(newVal.toFixed(1), `${label}: ${newVal.toFixed(2)}`);
      }, { passive: false });

      knob.addEventListener('dblclick', () => {
        this.engine.ensureAudioContext();
        this.engine.setParam(paramName, def);
        this.updateKnobVisual(knob, def, min, max, isExp);
        this.setDisplay('dEF', `${label} RESET`);
      });
    });
  }

  updateKnobVisual(knob, value, min, max, isExp) {
    let norm = isExp
      ? Math.log(value / min) / Math.log(max / min)
      : (value - min) / (max - min);
    norm = Math.max(0, Math.min(1, norm));

    const totalAngle = 270;
    const currentAngle = norm * totalAngle;
    const rotationDeg = -135 + currentAngle;

    knob.style.setProperty('--knob-angle', `${currentAngle}deg`);
    knob.style.setProperty('--knob-rotation', `${rotationDeg}deg`);
  }

  // =========================================================================
  // BUTTON TOGGLES & MODE SELECTORS
  // =========================================================================
  initModeButtons() {
    const modeBtns = document.querySelectorAll('[data-voice-mode]');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.voiceMode;
        this.engine.setParam('voiceMode', mode);
        this.setDisplay(mode.substring(0, 4), `VOICE MODE: ${mode}`);
      });
    });

    const subBtns = document.querySelectorAll('[data-sub-mode]');
    subBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        subBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.subMode;
        this.engine.setParam('subMode', mode);
        this.setDisplay('SUB', `SUB TYPE: ${mode}`);
      });
    });

    const lfoBtns = document.querySelectorAll('[data-lfo-wave]');
    lfoBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        lfoBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const wave = btn.dataset.lfoWave;
        this.engine.setParam('lfoWave', wave);
        this.setDisplay('LFO', `LFO WAVE: ${wave}`);
      });
    });

    const chorusBtns = document.querySelectorAll('[data-chorus-mode]');
    chorusBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        chorusBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.chorusMode;
        this.engine.setParam('chorusMode', mode);
        this.setDisplay('CHO', `CHORUS: ${mode}`);
      });
    });

    if (window.S1_PRESETS && this.presetSelect) {
      this.presetSelect.innerHTML = '';
      window.S1_PRESETS.forEach((preset, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = preset.name;
        this.presetSelect.appendChild(opt);
      });

      this.presetSelect.addEventListener('change', (e) => {
        this.engine.ensureAudioContext();
        this.loadPresetIndex(parseInt(e.target.value, 10));
      });

      this.loadPresetIndex(0);
    }

    const btnRand = document.getElementById('btn-rand-pattern');
    if (btnRand) {
      btnRand.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        this.randomizePatternAndSound();
      });
    }

    const btnPower = document.getElementById('btn-power');
    if (btnPower) {
      btnPower.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        this.engine.isMuted = !this.engine.isMuted;
        btnPower.classList.toggle('active', !this.engine.isMuted);
        this.setDisplay(this.engine.isMuted ? 'MUtE' : 'POWr', this.engine.isMuted ? 'AUDIO MUTED' : 'AUDIO ACTIVE');
      });
    }
  }

  loadPresetIndex(idx) {
    const preset = window.S1_PRESETS[idx];
    if (!preset) return;

    for (const [key, val] of Object.entries(preset.params)) {
      this.engine.setParam(key, val);
      const knob = document.querySelector(`.rotary-knob[data-param="${key}"]`);
      if (knob) {
        const min = parseFloat(knob.dataset.min);
        const max = parseFloat(knob.dataset.max);
        const isExp = knob.dataset.curve === 'exp';
        this.updateKnobVisual(knob, val, min, max, isExp);
      }
    }

    if (preset.tempo) {
      this.engine.setParam('tempo', preset.tempo);
      const tempoKnob = document.getElementById('knob-tempo');
      if (tempoKnob) this.updateKnobVisual(tempoKnob, preset.tempo, 40, 240, false);
    }

    if (preset.pattern) {
      this.seq.loadPattern(preset.pattern);
      this.updateStepSelectKeysUI();
      this.updateNoteKeysHighlight();
      this.updatePageButtonsUI();
    }

    this.setDisplay(`P-${(idx + 1).toString().padStart(2, '0')}`, preset.name);
  }

  randomizePatternAndSound() {
    const scale = [48, 51, 53, 55, 58, 60, 63, 65, 67, 70, 72];
    for (let i = 0; i < 16; i++) {
      const step = this.seq.steps[i];
      step.notes = new Set();
      if (Math.random() > 0.35) {
        step.notes.add(scale[Math.floor(Math.random() * scale.length)]);
      }
      step.substep = Math.random() > 0.8 ? 2 : 1;
      step.probability = Math.random() > 0.85 ? 0.75 : 1.0;
    }
    this.updateStepSelectKeysUI();
    this.updateNoteKeysHighlight();
    this.setDisplay('rAnd', 'PATTERN RANDOMIZED');
  }

  // =========================================================================
  // TRANSPORT & SEQUENCER CONTROLS
  // =========================================================================
  initTransport() {
    const btnPlay = document.getElementById('btn-play');
    const btnRec = document.getElementById('btn-record');
    const btnStepLoop = document.getElementById('btn-step-loop');
    const btnArp = document.getElementById('btn-arp');

    btnPlay.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.seq.togglePlay();
    });

    btnRec.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.seq.isRecordingMotion = !this.seq.isRecordingMotion;
      btnRec.classList.toggle('active', this.seq.isRecordingMotion);
      this.setDisplay(this.seq.isRecordingMotion ? 'rEC.' : 'OFF', 'MOTION RECORDING');
    });

    btnStepLoop.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.seq.isStepLoop = !this.seq.isStepLoop;
      btnStepLoop.classList.toggle('active', this.seq.isStepLoop);
      this.seq.stepLoopStart = this.seq.currentPage * 16;
      this.setDisplay(this.seq.isStepLoop ? 'LOOP' : 'PLAY', 'STEP LOOP SLICER');
    });

    btnArp.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.seq.isArpActive = !this.seq.isArpActive;
      btnArp.classList.toggle('active', this.seq.isArpActive);
      this.setDisplay(this.seq.isArpActive ? 'ArP.' : 'OFF', 'ARPEGGIATOR');
    });

    const pageBtns = document.querySelectorAll('.page-btn');
    let lastTapTimes = new Map();
    let tapTimeouts = new Map();

    pageBtns.forEach(btn => {
      const pageIdx = parseInt(btn.dataset.page, 10);

      btn.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        const now = Date.now();
        const lastTap = lastTapTimes.get(pageIdx) || 0;
        const isDoubleTap = (now - lastTap < 350);
        lastTapTimes.set(pageIdx, now);

        if (isDoubleTap) {
          // Double-tap detected: cancel pending single-tap action
          const pending = tapTimeouts.get(pageIdx);
          if (pending) {
            clearTimeout(pending);
            tapTimeouts.delete(pageIdx);
          }

          // Toggle or expand page loop
          const loopInfo = this.seq.togglePageLoop(pageIdx);
          this.seq.currentPage = pageIdx;
          this.seq.selectedStep = null;
          this.updatePageButtonsUI();
          this.updateStepSelectKeysUI();
          this.updateNoteKeysHighlight();

          if (loopInfo.isLooping) {
            const startP = loopInfo.start + 1;
            const endP = loopInfo.end + 1;
            const startStep = loopInfo.start * 16 + 1;
            const endStep = (loopInfo.end + 1) * 16;
            if (startP === endP) {
              this.setDisplay(`LP0${startP}`, `PAGE ${startP} LOOP ACTIVE (STEPS ${startStep}-${endStep})`);
            } else {
              this.setDisplay(`L${startP}-${endP}`, `PAGES ${startP}-${endP} LOOP ACTIVE (STEPS ${startStep}-${endStep})`);
            }
          } else {
            const pageNum = pageIdx + 1;
            const startStep = pageIdx * 16 + 1;
            const endStep = (pageIdx + 1) * 16;
            this.setDisplay(`PG ${pageNum}`, `PAGE ${pageNum} (STEPS ${startStep}-${endStep}) • LOOP OFF`);
          }
        } else {
          // Single-tap: wait briefly to distinguish from double-tap
          const timeout = setTimeout(() => {
            tapTimeouts.delete(pageIdx);

            this.seq.currentPage = pageIdx;
            this.seq.selectedStep = null;
            this.updatePageButtonsUI();
            this.updateStepSelectKeysUI();
            this.updateNoteKeysHighlight();

            const pageNum = pageIdx + 1;
            const startStep = pageIdx * 16 + 1;
            const endStep = (pageIdx + 1) * 16;
            if (this.seq.isPageLoop) {
              const startP = this.seq.pageLoopStart + 1;
              const endP = this.seq.pageLoopEnd + 1;
              if (startP === endP) {
                this.setDisplay(`LP0${startP}`, `PAGE ${pageNum} VIEW (LOOPING PAGE ${startP})`);
              } else {
                this.setDisplay(`L${startP}-${endP}`, `PAGE ${pageNum} VIEW (LOOPING PAGES ${startP}-${endP})`);
              }
            } else {
              this.setDisplay(`PG ${pageNum}`, `PAGE ${pageNum} (STEPS ${startStep}-${endStep})`);
            }
          }, 220);

          tapTimeouts.set(pageIdx, timeout);
        }
      });
    });

    const btnOctDown = document.getElementById('btn-oct-down');
    const btnOctUp = document.getElementById('btn-oct-up');

    btnOctDown.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      if (this.currentOctave > -3) {
        this.setOctave(this.currentOctave - 1, true);
      }
    });

    btnOctUp.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      if (this.currentOctave < 3) {
        this.setOctave(this.currentOctave + 1, true);
      }
    });

    const editModeBtns = document.querySelectorAll('[data-step-edit-mode]');
    editModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.engine.ensureAudioContext();
        editModeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.seq.editMode = btn.dataset.stepEditMode;
        this.seq.selectedStep = null;
        this.updateStepSelectKeysUI();
        this.updateNoteKeysHighlight();
        if (this.seq.editMode === 'prob') {
          this.setDisplay('PrOb', 'EDIT: PROBABILITY (CLICK A STEP TO VIEW/SET %)');
        } else {
          this.setDisplay(this.seq.editMode.substring(0, 4).toUpperCase(), `EDIT MODE: ${this.seq.editMode.toUpperCase()}`);
        }
      });
    });

    const btnClear = document.getElementById('btn-clear-pattern');
    btnClear.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.seq.clearPattern();
      this.updateStepSelectKeysUI();
      this.updateNoteKeysHighlight();
      this.updatePageButtonsUI();
      this.setDisplay('CLr', 'PATTERN CLEARED');
    });

    this.seq.onStepTick = (stepIdx, localIdx, pageOfStep, isTriggered) => {
      if (!this.seq.isPlaying) return;
      const keys = document.querySelectorAll('.step-select-key');
      keys.forEach(k => k.classList.remove('current-chase'));

      if (pageOfStep === this.seq.currentPage) {
        const activeKey = keys[localIdx];
        if (activeKey) {
          activeKey.classList.add('current-chase');
        }
      }
    };

    this.seq.onPlayChange = (isPlaying) => {
      btnPlay.classList.toggle('active', isPlaying);
      btnPlay.querySelector('.btn-label').textContent = isPlaying ? '■ STOP' : '▶ PLAY';
      this.setDisplay(isPlaying ? 'PLAY' : 'StOP', isPlaying ? 'SEQUENCER RUNNING' : 'SEQUENCER STOPPED');

      if (!isPlaying) {
        const selectKeys = document.querySelectorAll('.step-select-key');
        selectKeys.forEach(k => k.classList.remove('current-chase'));
        const noteKeys = document.querySelectorAll('.step-key');
        noteKeys.forEach(k => k.classList.remove('current-chase'));
      }
    };
  }

  // =========================================================================
  // 16 TACTILE STEP KEYS & KEYBOARD
  // =========================================================================
  initStepKeys() {
    const noteKeys = document.querySelectorAll('.step-key');
    const selectKeys = document.querySelectorAll('.step-select-key');

    noteKeys.forEach(key => {
      const noteOffset = parseInt(key.dataset.note, 10) - 60;

      const playNote = () => {
        this.engine.ensureAudioContext();
        const midiNote = 60 + (this.currentOctave * 12) + noteOffset;
        this.engine.triggerNoteOn(midiNote, 0.9);
        key.classList.add('key-pressed');
        this.pressedKeys.add(midiNote);
        if (this.seq.isArpActive) this.seq.setArpHeldNotes(Array.from(this.pressedKeys));
      };

      const releaseNote = () => {
        const midiNote = 60 + (this.currentOctave * 12) + noteOffset;
        this.engine.triggerNoteOff(midiNote);
        key.classList.remove('key-pressed');
        this.pressedKeys.delete(midiNote);
        if (this.seq.isArpActive) this.seq.setArpHeldNotes(Array.from(this.pressedKeys));
      };

      key.addEventListener('pointerdown', () => {
        this.engine.ensureAudioContext();
        playNote();
        const midiNote = 60 + (this.currentOctave * 12) + noteOffset;
        const step = this.seq.toggleNoteOnSelectedStep(midiNote);
        if (step) {
          this.updateNoteKeysHighlight();
          this.updateStepSelectKeysUI();
        }
      });

      key.addEventListener('pointerup', releaseNote);
      key.addEventListener('pointerleave', releaseNote);
      key.addEventListener('pointercancel', releaseNote);
    });

    selectKeys.forEach(key => {
      const localIdx = parseInt(key.dataset.stepSelect, 10);

      key.addEventListener('pointerdown', () => {
        this.engine.ensureAudioContext();
        const res = this.seq.handleStepSelectPress(localIdx);

        // When selecting a step with note(s), automatically sync the octave view to its base note
        if (res && res.step && res.step.notes && res.step.notes.size > 0) {
          const baseNote = Math.min(...res.step.notes);
          const noteOctave = Math.max(-3, Math.min(3, Math.floor((baseNote - 60) / 12)));
          this.setOctave(noteOctave, false);
        }

        this.updateStepSelectKeysUI();
        this.updateNoteKeysHighlight();

        const stepNum = (localIdx + 1).toString().padStart(2, '0');
        if (this.seq.editMode === 'select') {
          const isSelected = this.seq.selectedStep === (this.seq.currentPage * 16) + localIdx;
          const gateLen = res && res.step ? (res.step.gateLength || 1) : 1;
          if (res && res.changed) {
            // Gate incremented on repeated tap
            const dispGate = `G-${gateLen.toString().padStart(2, '0')}`;
            this.setDisplay(dispGate, `STEP ${stepNum} GATE LENGTH: ${gateLen} ${gateLen === 1 ? 'STEP' : 'STEPS'}`);
          } else if (isSelected) {
            if (gateLen > 1) {
              const dispGate = `G-${gateLen.toString().padStart(2, '0')}`;
              this.setDisplay(dispGate, `STEP ${stepNum} SELECTED (GATE: ${gateLen} STEPS)`);
            } else {
              this.setDisplay(`SL${stepNum}`, `STEP ${stepNum} SELECTED`);
            }
          } else {
            this.setDisplay('----', 'STEP DESELECTED');
          }
        } else if (this.seq.editMode === 'prob') {
          const pct = res && res.step ? Math.round(res.step.probability * 100) : 100;
          const dispPct = pct === 100 ? '100%' : `${pct}%`.padStart(4, ' ');
          this.setDisplay(dispPct, `STEP ${stepNum} PROBABILITY: ${pct}%`);
        }
      });
    });

    this.updateStepSelectKeysUI();
    this.updateNoteKeysHighlight();
  }

  updateStepSelectKeysUI() {
    const keys = document.querySelectorAll('.step-select-key');
    const startIdx = this.seq.currentPage * 16;
    const selectedStep = this.seq.selectedStep;
    const selStepObj = (selectedStep !== null) ? this.seq.steps[selectedStep] : null;
    const gateLen = (selStepObj && selStepObj.gateLength) ? selStepObj.gateLength : 1;

    keys.forEach((key, i) => {
      const stepIdx = startIdx + i;
      const step = this.seq.steps[stepIdx];
      if (!step) return;

      const isSelected = (selectedStep === stepIdx);
      const isGateTrail = (selectedStep !== null && stepIdx >= selectedStep && stepIdx < (selectedStep + gateLen));

      key.classList.toggle('active-step', step.notes.size > 0);
      key.classList.toggle('has-prob', step.probability < 1.0);
      key.classList.toggle('selected', isSelected);
      key.classList.toggle('gate-trail', isGateTrail);
    });
  }

  updatePageButtonsUI() {
    const pageBtns = document.querySelectorAll('.page-btn');
    pageBtns.forEach(btn => {
      const p = parseInt(btn.dataset.page, 10);
      const isLooping = this.seq.isPageLoop && (p >= this.seq.pageLoopStart && p <= this.seq.pageLoopEnd);
      btn.classList.toggle('active', this.seq.currentPage === p);
      btn.classList.toggle('page-looping', isLooping);
    });
  }

  updateNoteKeysHighlight() {
    const noteKeys = document.querySelectorAll('.step-key');
    const selectedStep = this.seq.selectedStep !== null ? this.seq.steps[this.seq.selectedStep] : null;
    const stepNotes = selectedStep ? selectedStep.notes : null;

    noteKeys.forEach(key => {
      const noteOffset = parseInt(key.dataset.note, 10) - 60;
      const midiNote = 60 + (this.currentOctave * 12) + noteOffset;
      key.classList.toggle('note-in-step', !!stepNotes && stepNotes.has(midiNote));
    });
  }

  // =========================================================================
  // OLED OSCILLOSCOPE
  // =========================================================================
  initOscilloscope() {
    const canvas = this.scopeCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let dataArray = null;

    const render = () => {
      requestAnimationFrame(render);
      const analyser = this.engine.analyser;

      ctx.fillStyle = '#060a08';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid
      ctx.strokeStyle = 'rgba(0, 255, 127, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x += 22) {
        ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
      }
      for (let y = 0; y < canvas.height; y += 16) {
        ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
      }
      ctx.stroke();

      ctx.strokeStyle = 'rgba(0, 255, 127, 0.15)';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      if (!analyser) return;

      if (!dataArray || dataArray.length !== analyser.frequencyBinCount) {
        dataArray = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteTimeDomainData(dataArray);

      // Phosphor Waveform
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00ff7f';
      ctx.shadowColor = '#00ff7f';
      ctx.shadowBlur = 8;
      ctx.beginPath();

      const sliceWidth = canvas.width / dataArray.length;
      let x = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    render();
  }

  // =========================================================================
  // OSC DRAW MODAL CANVAS
  // =========================================================================
  initDrawModal() {
    const modal = document.getElementById('draw-modal');
    const btnOpen = document.getElementById('btn-open-draw');
    const btnClose = document.getElementById('btn-close-draw');
    const btnApply = document.getElementById('btn-apply-draw');
    const canvas = document.getElementById('draw-canvas');
    if (!canvas || !modal) return;
    const ctx = canvas.getContext('2d');

    const numPoints = 64;
    let wavePoints = new Float32Array(this.engine.drawnWavePoints);

    const drawGridAndWave = () => {
      ctx.fillStyle = '#080c10';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = 'rgba(255, 145, 0, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x += 32) {
        ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
      }
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      ctx.strokeStyle = '#ff9100';
      ctx.shadowColor = 'rgba(255, 145, 0, 0.6)';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 3;
      ctx.beginPath();

      const stepX = canvas.width / numPoints;
      for (let i = 0; i < numPoints; i++) {
        const normY = wavePoints[i];
        const canvasY = (canvas.height / 2) - (normY * (canvas.height * 0.45));
        const canvasX = i * stepX + (stepX / 2);
        if (i === 0) ctx.moveTo(canvasX, canvasY);
        else ctx.lineTo(canvasX, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    btnOpen.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      modal.hidden = false;
      wavePoints = new Float32Array(this.engine.drawnWavePoints);
      drawGridAndWave();
    });

    btnClose.addEventListener('click', () => { modal.hidden = true; });

    btnApply.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.engine.setDrawnWaveform(wavePoints);
      this.engine.setParam('oscDrawMix', Math.max(0.4, this.engine.params.oscDrawMix));
      const drawKnob = document.querySelector('.rotary-knob[data-param="oscDrawMix"]');
      if (drawKnob) {
        this.updateKnobVisual(drawKnob, this.engine.params.oscDrawMix, 0, 1, false);
      }
      modal.hidden = true;
      this.setDisplay('drAW', 'CUSTOM WAVE APPLIED');
    });

    let isDrawing = false;
    const plotPoint = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0].clientX);
      const clientY = e.clientY || (e.touches && e.touches[0].clientY);
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const idx = Math.floor((x / canvas.width) * numPoints);
      if (idx >= 0 && idx < numPoints) {
        const val = -((y - canvas.height / 2) / (canvas.height * 0.45));
        wavePoints[idx] = Math.max(-1, Math.min(1, val));
        drawGridAndWave();
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      isDrawing = true;
      plotPoint(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (isDrawing) plotPoint(e);
    });
    window.addEventListener('pointerup', () => { isDrawing = false; });

    const presetBtns = document.querySelectorAll('[data-draw-preset]');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.drawPreset;
        for (let i = 0; i < numPoints; i++) {
          const t = i / numPoints;
          if (p === 'sine') wavePoints[i] = Math.sin(t * Math.PI * 2);
          else if (p === 'triangle') wavePoints[i] = 1 - 4 * Math.abs(Math.round(t - 0.25) - (t - 0.25));
          else if (p === 'saw') wavePoints[i] = 2 * (t - Math.floor(t + 0.5));
          else if (p === 'square') wavePoints[i] = t < 0.5 ? 0.9 : -0.9;
          else if (p === 'organ') wavePoints[i] = 0.6 * Math.sin(t * Math.PI * 2) + 0.4 * Math.sin(t * Math.PI * 6);
          else if (p === 'bell') wavePoints[i] = Math.sin(t * Math.PI * 2) * Math.sin(t * Math.PI * 14);
          else if (p === 'vocal') wavePoints[i] = Math.sin(t * Math.PI * 4) + 0.5 * Math.sin(t * Math.PI * 8);
          else if (p === 'smooth') {
            const prev = wavePoints[(i - 1 + numPoints) % numPoints];
            const next = wavePoints[(i + 1) % numPoints];
            wavePoints[i] = (prev + wavePoints[i] + next) / 3;
          }
          else if (p === 'invert') wavePoints[i] = -wavePoints[i];
        }
        drawGridAndWave();
      });
    });
  }

  // =========================================================================
  // WEB MIDI API INTEGRATION
  // =========================================================================
  initMidi() {
    const midiLed = document.getElementById('midi-led');
    if (navigator.requestMIDIAccess) {
      navigator.requestMIDIAccess().then(
        (midiAccess) => {
          if (midiLed) midiLed.classList.add('active');
          this.setDisplay('MIdI', 'MIDI READY');
          for (const input of midiAccess.inputs.values()) {
            input.onmidimessage = (msg) => this.handleMidiMessage(msg);
          }
          midiAccess.onstatechange = (e) => {
            if (e.port.type === 'input') {
              e.port.onmidimessage = (msg) => this.handleMidiMessage(msg);
            }
          };
        },
        () => {}
      );
    }
  }

  handleMidiMessage(event) {
    this.engine.ensureAudioContext();
    const [status, note, velocity] = event.data;
    const command = status >> 4;
    const midiLed = document.getElementById('midi-led');

    if (midiLed) {
      midiLed.style.boxShadow = '0 0 14px #00e5ff';
      setTimeout(() => { midiLed.style.boxShadow = ''; }, 100);
    }

    if (command === 9 && velocity > 0) {
      this.engine.triggerNoteOn(note, velocity / 127);
    } else if (command === 8 || (command === 9 && velocity === 0)) {
      this.engine.triggerNoteOff(note);
    }
  }

  // =========================================================================
  // WAV AUDIO RECORDING
  // =========================================================================
  initRecorder() {
    const btnRec = document.getElementById('btn-record-wav');
    const recLed = document.getElementById('rec-led');
    const recLabel = document.getElementById('rec-label');
    if (!btnRec) return;

    btnRec.addEventListener('click', async () => {
      this.engine.ensureAudioContext();
      if (!this.engine.isRecording) {
        const started = this.engine.startRecording();
        if (started) {
          recLed.classList.add('recording');
          recLabel.textContent = 'STOP REC';
          this.setDisplay('rEC', 'RECORDING WAV');
        }
      } else {
        const blob = await this.engine.stopRecording();
        recLed.classList.remove('recording');
        recLabel.textContent = 'REC WAV';
        this.setDisplay('SAUE', 'WAV READY');

        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = `Roland_S1_Jam_${Date.now()}.webm`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 2000);
        }
      }
    });
  }
}

window.S1UIController = S1UIController;
