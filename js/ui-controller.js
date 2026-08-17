/**
 * Roland AIRA Compact S-1 Tweak Synth - UI & Interaction Controller
 * Rotary knobs, 7-segment LED screen, OLED oscilloscope, OSC Draw canvas, MIDI & Key bindings
 */

class S1UIController {
  constructor(audioEngine, sequencer) {
    this.engine = audioEngine;
    this.seq = sequencer;

    this.currentOctave = 4; // MIDI note 60 = C4
    this.displayTimeout = null;

    // Active playing notes (for keyboard & step keys)
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
    const chars = (text + '    ').substring(0, 4).toUpperCase();
    this.seg1.textContent = chars[0];
    this.seg2.textContent = chars[1];
    this.seg3.textContent = chars[2];
    this.seg4.textContent = chars[3];

    if (subtext) {
      this.subInfo.textContent = subtext.toUpperCase();
    }

    if (this.displayTimeout) clearTimeout(this.displayTimeout);
    this.displayTimeout = setTimeout(() => {
      this.seg1.textContent = 'S';
      this.seg2.textContent = '-';
      this.seg3.textContent = '0';
      this.seg4.textContent = '1';
      this.subInfo.textContent = `READY • TEMPO ${this.engine.params.tempo}`;
    }, 2500);
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

      // Set initial visual position
      const initialVal = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
      this.updateKnobVisual(knob, initialVal, min, max, isExp);

      let startY = 0;
      let startVal = initialVal;
      let isDragging = false;

      const onPointerDown = (e) => {
        isDragging = true;
        startY = e.clientY || (e.touches && e.touches[0].clientY);
        startVal = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
        document.body.style.cursor = 'ns-resize';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        e.preventDefault();
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

        // Quantize step if integer
        if (knob.dataset.step && parseFloat(knob.dataset.step) >= 1) {
          newVal = Math.round(newVal);
        }

        // Apply parameter to engine & sequencer motion
        this.engine.setParam(paramName, newVal);
        this.seq.recordMotion(paramName, newVal);
        this.updateKnobVisual(knob, newVal, min, max, isExp);

        // Update 7-Segment Screen
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

      // Wheel support
      knob.addEventListener('wheel', (e) => {
        e.preventDefault();
        const cur = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
        const step = (max - min) * 0.025 * (e.deltaY < 0 ? 1 : -1);
        const newVal = Math.max(min, Math.min(max, cur + step));
        this.engine.setParam(paramName, newVal);
        this.seq.recordMotion(paramName, newVal);
        this.updateKnobVisual(knob, newVal, min, max, isExp);
        this.setDisplay(newVal.toFixed(1), `${label}: ${newVal.toFixed(2)}`);
      }, { passive: false });

      // Double-click to reset to default
      knob.addEventListener('dblclick', () => {
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
    // Voice Mode buttons
    const modeBtns = document.querySelectorAll('[data-voice-mode]');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.voiceMode;
        this.engine.setParam('voiceMode', mode);
        this.setDisplay(mode.substring(0, 4), `VOICE MODE: ${mode}`);
      });
    });

    // Sub Type buttons
    const subBtns = document.querySelectorAll('[data-sub-mode]');
    subBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        subBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.subMode;
        this.engine.setParam('subMode', mode);
        this.setDisplay('SUB', `SUB TYPE: ${mode}`);
      });
    });

    // LFO Wave buttons
    const lfoBtns = document.querySelectorAll('[data-lfo-wave]');
    lfoBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        lfoBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const wave = btn.dataset.lfoWave;
        this.engine.setParam('lfoWave', wave);
        this.setDisplay('LFO', `LFO WAVE: ${wave}`);
      });
    });

    // Chorus Mode buttons
    const chorusBtns = document.querySelectorAll('[data-chorus-mode]');
    chorusBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        chorusBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.chorusMode;
        this.engine.setParam('chorusMode', mode);
        this.setDisplay('CHO', `CHORUS: ${mode}`);
      });
    });

    // Preset Selector Dropdown
    if (window.S1_PRESETS) {
      window.S1_PRESETS.forEach((preset, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = preset.name;
        this.presetSelect.appendChild(opt);
      });

      this.presetSelect.addEventListener('change', (e) => {
        this.loadPresetIndex(parseInt(e.target.value, 10));
      });

      // Load initial preset 0
      this.loadPresetIndex(0);
    }

    // Randomize Button
    const btnRand = document.getElementById('btn-rand-pattern');
    if (btnRand) {
      btnRand.addEventListener('click', () => {
        this.randomizePatternAndSound();
      });
    }

    // Power Toggle
    const btnPower = document.getElementById('btn-power');
    if (btnPower) {
      btnPower.addEventListener('click', () => {
        this.engine.isMuted = !this.engine.isMuted;
        btnPower.classList.toggle('active', !this.engine.isMuted);
        this.setDisplay(this.engine.isMuted ? 'MUtE' : 'POWr', this.engine.isMuted ? 'AUDIO MUTED' : 'AUDIO ACTIVE');
      });
    }
  }

  loadPresetIndex(idx) {
    const preset = window.S1_PRESETS[idx];
    if (!preset) return;

    // Apply Sound parameters
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

    // Update tempo
    if (preset.tempo) {
      this.engine.setParam('tempo', preset.tempo);
      const tempoKnob = document.getElementById('knob-tempo');
      if (tempoKnob) this.updateKnobVisual(tempoKnob, preset.tempo, 40, 240, false);
    }

    // Load Sequencer Pattern
    if (preset.pattern) {
      this.seq.loadPattern(preset.pattern);
      this.updateStepKeysUI();
    }

    this.setDisplay(`P-${(idx + 1).toString().padStart(2, '0')}`, preset.name);
  }

  randomizePatternAndSound() {
    // Randomize scale notes (Pentatonic minor)
    const scale = [48, 51, 53, 55, 58, 60, 63, 65, 67, 70, 72];
    for (let i = 0; i < 16; i++) {
      const step = this.seq.steps[i];
      step.gate = Math.random() > 0.35;
      step.note = scale[Math.floor(Math.random() * scale.length)];
      step.substep = Math.random() > 0.8 ? 2 : 1;
      step.probability = Math.random() > 0.85 ? 0.75 : 1.0;
    }
    this.updateStepKeysUI();
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
      this.seq.togglePlay();
    });

    btnRec.addEventListener('click', () => {
      this.seq.isRecordingMotion = !this.seq.isRecordingMotion;
      btnRec.classList.toggle('active', this.seq.isRecordingMotion);
      this.setDisplay(this.seq.isRecordingMotion ? 'rEC.' : 'OFF', 'MOTION RECORDING');
    });

    btnStepLoop.addEventListener('click', () => {
      this.seq.isStepLoop = !this.seq.isStepLoop;
      btnStepLoop.classList.toggle('active', this.seq.isStepLoop);
      this.seq.stepLoopStart = this.seq.currentPage * 16;
      this.setDisplay(this.seq.isStepLoop ? 'LOOP' : 'PLAY', 'STEP LOOP SLICER');
    });

    btnArp.addEventListener('click', () => {
      this.seq.isArpActive = !this.seq.isArpActive;
      btnArp.classList.toggle('active', this.seq.isArpActive);
      this.setDisplay(this.seq.isArpActive ? 'ArP.' : 'OFF', 'ARPEGGIATOR');
    });

    // Page Buttons (1-16, 17-32, 33-48, 49-64)
    const pageBtns = document.querySelectorAll('.page-btn');
    pageBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        pageBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.seq.currentPage = parseInt(btn.dataset.page, 10);
        this.updateStepKeysUI();
        this.setDisplay(`PG ${this.seq.currentPage + 1}`, `PAGE ${this.seq.currentPage + 1} (STEPS ${this.seq.currentPage * 16 + 1}-${(this.seq.currentPage + 1) * 16})`);
      });
    });

    // Octave Shift
    const btnOctDown = document.getElementById('btn-oct-down');
    const btnOctUp = document.getElementById('btn-oct-up');

    btnOctDown.addEventListener('click', () => {
      if (this.currentOctave > 1) {
        this.currentOctave--;
        this.octaveDisplay.textContent = `OCT ${this.currentOctave}`;
        this.setDisplay(`OC ${this.currentOctave}`, `OCTAVE ${this.currentOctave}`);
      }
    });

    btnOctUp.addEventListener('click', () => {
      if (this.currentOctave < 7) {
        this.currentOctave++;
        this.octaveDisplay.textContent = `OCT ${this.currentOctave}`;
        this.setDisplay(`OC ${this.currentOctave}`, `OCTAVE ${this.currentOctave}`);
      }
    });

    // Step Edit Mode (GATE, NOTE, PROB, FLAM)
    const editModeBtns = document.querySelectorAll('[data-step-edit-mode]');
    editModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        editModeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.seq.editMode = btn.dataset.stepEditMode;
        this.setDisplay(this.seq.editMode.substring(0, 4).toUpperCase(), `EDIT MODE: ${this.seq.editMode.toUpperCase()}`);
      });
    });

    // Clear Pattern
    const btnClear = document.getElementById('btn-clear-pattern');
    btnClear.addEventListener('click', () => {
      this.seq.clearPattern();
      this.updateStepKeysUI();
      this.setDisplay('CLr', 'PATTERN CLEARED');
    });

    // Sequencer tick callback -> LED chase & step highlight
    this.seq.onStepTick = (stepIdx, localIdx, pageOfStep, isTriggered) => {
      const keys = document.querySelectorAll('.step-key');
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
    };
  }

  // =========================================================================
  // 16 TACTILE STEP KEYS & KEYBOARD
  // =========================================================================
  initStepKeys() {
    const keys = document.querySelectorAll('.step-key');

    keys.forEach(key => {
      const localIdx = parseInt(key.dataset.step, 10);
      const noteOffset = parseInt(key.dataset.note, 10) - 60; // Relative to C4

      const playNote = () => {
        const midiNote = (this.currentOctave * 12) + noteOffset;
        this.engine.triggerNoteOn(midiNote, 0.9);
        key.classList.add('key-pressed');
        this.pressedKeys.add(midiNote);
        if (this.seq.isArpActive) this.seq.setArpHeldNotes(Array.from(this.pressedKeys));
      };

      const releaseNote = () => {
        const midiNote = (this.currentOctave * 12) + noteOffset;
        this.engine.triggerNoteOff(midiNote);
        key.classList.remove('key-pressed');
        this.pressedKeys.delete(midiNote);
        if (this.seq.isArpActive) this.seq.setArpHeldNotes(Array.from(this.pressedKeys));
      };

      key.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        playNote();
        const currentOctaveNote = (this.currentOctave * 12) + noteOffset;
        const step = this.seq.toggleStep(localIdx, currentOctaveNote);
        this.updateSingleStepKeyUI(key, step);
      });

      key.addEventListener('pointerup', releaseNote);
      key.addEventListener('pointerleave', releaseNote);
      key.addEventListener('pointercancel', releaseNote);
    });

    this.updateStepKeysUI();
  }

  updateSingleStepKeyUI(keyElement, step) {
    keyElement.classList.toggle('active-step', step.gate);
    keyElement.classList.toggle('has-prob', step.probability < 1.0);
    keyElement.classList.toggle('has-ratchet', step.substep > 1);
  }

  updateStepKeysUI() {
    const keys = document.querySelectorAll('.step-key');
    const startIdx = this.seq.currentPage * 16;
    keys.forEach((key, i) => {
      const step = this.seq.steps[startIdx + i];
      if (step) {
        this.updateSingleStepKeyUI(key, step);
      }
    });
  }

  // =========================================================================
  // OLED OSCILLOSCOPE & FFT DISPLAY
  // =========================================================================
  initOscilloscope() {
    const canvas = this.scopeCanvas;
    const ctx = canvas.getContext('2d');
    const analyser = this.engine.analyser;
    const bufferLength = analyser ? analyser.frequencyBinCount : 1024;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      requestAnimationFrame(render);
      if (!analyser) return;

      analyser.getByteTimeDomainData(dataArray);

      ctx.fillStyle = '#060a08';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw CRT Matrix Grid Lines
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

      // Center Reference Line
      ctx.strokeStyle = 'rgba(0, 255, 127, 0.15)';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      // Oscilloscope Phosphor Waveform
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00ff7f';
      ctx.shadowColor = '#00ff7f';
      ctx.shadowBlur = 8;
      ctx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0; // Reset
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
    const ctx = canvas.getContext('2d');

    const numPoints = 64;
    let wavePoints = new Float32Array(this.engine.drawnWavePoints);

    const drawGridAndWave = () => {
      ctx.fillStyle = '#080c10';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid
      ctx.strokeStyle = 'rgba(255, 145, 0, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x += 32) {
        ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
      }
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      // Waveform trace
      ctx.strokeStyle = '#ff9100';
      ctx.shadowColor = 'rgba(255, 145, 0, 0.6)';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 3;
      ctx.beginPath();

      const stepX = canvas.width / numPoints;
      for (let i = 0; i < numPoints; i++) {
        const normY = wavePoints[i]; // -1 to 1
        const canvasY = (canvas.height / 2) - (normY * (canvas.height * 0.45));
        const canvasX = i * stepX + (stepX / 2);
        if (i === 0) ctx.moveTo(canvasX, canvasY);
        else ctx.lineTo(canvasX, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    btnOpen.addEventListener('click', () => {
      modal.hidden = false;
      wavePoints = new Float32Array(this.engine.drawnWavePoints);
      drawGridAndWave();
    });

    btnClose.addEventListener('click', () => { modal.hidden = true; });

    btnApply.addEventListener('click', () => {
      this.engine.setDrawnWaveform(wavePoints);
      this.engine.setParam('oscDrawMix', Math.max(0.4, this.engine.params.oscDrawMix));
      const drawKnob = document.querySelector('.rotary-knob[data-param="oscDrawMix"]');
      if (drawKnob) {
        this.updateKnobVisual(drawKnob, this.engine.params.oscDrawMix, 0, 1, false);
      }
      modal.hidden = true;
      this.setDisplay('drAW', 'CUSTOM WAVE APPLIED');
    });

    // Drawing Interaction
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

    // Preset Waveform Buttons
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
          midiLed.classList.add('active');
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
        () => console.log('Web MIDI access not granted')
      );
    }
  }

  handleMidiMessage(event) {
    const [status, note, velocity] = event.data;
    const command = status >> 4;
    const midiLed = document.getElementById('midi-led');

    // Flash MIDI LED
    if (midiLed) {
      midiLed.style.boxShadow = '0 0 14px #00e5ff';
      setTimeout(() => { midiLed.style.boxShadow = ''; }, 100);
    }

    if (command === 9 && velocity > 0) {
      // Note On
      this.engine.triggerNoteOn(note, velocity / 127);
    } else if (command === 8 || (command === 9 && velocity === 0)) {
      // Note Off
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

    btnRec.addEventListener('click', async () => {
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
