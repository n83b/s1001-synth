/**
 * Barnestorm S-1001 Tweak Synth - UI & Interaction Controller
 * Rotary knobs, status display, oscilloscope, OSC Draw canvas, MIDI, and key bindings
 */

class S1UIController {
  constructor(audioEngine, sequencer) {
    this.engine = audioEngine;
    this.seq = sequencer;

    this.currentOctave = 0; // Center octave: 0 (range -3 to +3, 0 = C4/60)
    this.displayTimeout = null;
    this.isStepClearPending = false;
    this.isPatternClearPending = false;
    this.storageKey = 'barnestorm-s1001-state-v2';
    this.persistenceTimeout = null;

    // Active playing notes
    this.pressedKeys = new Set();
    this.pressedPointerNotes = new Map();

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
    this.initPersistence();
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
  setDisplay(text, subtext = '', persistent = false) {
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
    this.displayTimeout = null;

    if (!persistent) {
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

  moveSelectedStep(direction) {
    if (this.seq.selectedStep === null) return false;

    const targetStep = Math.max(
      0,
      Math.min(this.seq.totalSteps - 1, this.seq.selectedStep + direction)
    );
    if (targetStep === this.seq.selectedStep) return false;

    this.seq.selectedStep = targetStep;
    this.seq.currentPage = Math.floor(targetStep / this.seq.stepsPerPage);

    const step = this.seq.steps[targetStep];
    if (step && step.notes.size > 0) {
      const baseNote = Math.min(...step.notes);
      this.setOctave(Math.floor((baseNote - 60) / 12), false);
    }

    this.updatePageButtonsUI();
    this.updateStepSelectKeysUI();
    this.updateNoteKeysHighlight();
    this.updateAllKnobsVisual();
    this.setDisplay(`S${(targetStep + 1).toString().padStart(3, '0')}`, `STEP ${targetStep + 1} SELECTED`);
    this.scheduleSessionSave();
    return true;
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
      const stepSize = parseFloat(knob.dataset.step) || 0;
      const stepDecimals = knob.dataset.step && knob.dataset.step.includes('.')
        ? knob.dataset.step.split('.')[1].length
        : 0;
      const isExp = knob.dataset.curve === 'exp';
      const label = knob.dataset.label || paramName;
      const quantizeValue = (value) => {
        if (stepSize <= 0) return value;
        const quantized = Math.round(value / stepSize) * stepSize;
        return Number(quantized.toFixed(stepDecimals));
      };

      const initialVal = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
      this.updateKnobVisual(knob, initialVal, min, max, isExp);

      let startY = 0;
      let startVal = initialVal;
      let isDragging = false;

      const onPointerDown = (e) => {
        this.engine.ensureAudioContext();
        isDragging = true;
        startY = e.clientY || (e.touches && e.touches[0].clientY);
        let curVal;
        if (this.seq.selectedStep !== null) {
          const stepVal = this.seq.getStepParam(this.seq.selectedStep, paramName);
          curVal = (stepVal !== null && stepVal !== undefined) ? stepVal : (this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def);
        } else {
          curVal = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
        }
        startVal = curVal;
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

        newVal = Math.max(min, Math.min(max, quantizeValue(newVal)));

        this.engine.setParam(paramName, newVal);
        this.seq.recordMotion(paramName, newVal);
        if (this.seq.selectedStep !== null && this.seq.isRecordingMotion) {
          this.seq.setStepParam(this.seq.selectedStep, paramName, newVal);
        }
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
        let cur;
        if (this.seq.selectedStep !== null) {
          const stepVal = this.seq.getStepParam(this.seq.selectedStep, paramName);
          cur = (stepVal !== null && stepVal !== undefined) ? stepVal : (this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def);
        } else {
          cur = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
        }
        const wheelDelta = (max - min) * 0.025 * (e.deltaY < 0 ? 1 : -1);
        const newVal = Math.max(min, Math.min(max, quantizeValue(cur + wheelDelta)));
        this.engine.setParam(paramName, newVal);
        this.seq.recordMotion(paramName, newVal);
        if (this.seq.selectedStep !== null && this.seq.isRecordingMotion) {
          this.seq.setStepParam(this.seq.selectedStep, paramName, newVal);
        }
        this.updateKnobVisual(knob, newVal, min, max, isExp);
        this.setDisplay(newVal.toFixed(1), `${label}: ${newVal.toFixed(2)}`);
      }, { passive: false });

      knob.addEventListener('dblclick', () => {
        this.engine.ensureAudioContext();
        this.engine.setParam(paramName, def);
        if (this.seq.selectedStep !== null && this.seq.isRecordingMotion) {
          this.seq.setStepParam(this.seq.selectedStep, paramName, def);
        }
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

  updateAllKnobsVisual(targetStepIdx = null) {
    const stepIdx = (targetStepIdx !== null) ? targetStepIdx : this.seq.selectedStep;
    const knobs = document.querySelectorAll('.rotary-knob');

    knobs.forEach((knob) => {
      const paramName = knob.dataset.param;
      const min = parseFloat(knob.dataset.min);
      const max = parseFloat(knob.dataset.max);
      const def = parseFloat(knob.dataset.default);
      const isExp = knob.dataset.curve === 'exp';

      let val;
      if (stepIdx !== null) {
        const stepVal = this.seq.getStepParam(stepIdx, paramName);
        val = (stepVal !== null && stepVal !== undefined) ? stepVal : (this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def);
      } else {
        val = this.engine.params[paramName] !== undefined ? this.engine.params[paramName] : def;
      }

      this.updateKnobVisual(knob, val, min, max, isExp);
    });
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
        const presetIndex = parseInt(e.target.value, 10);
        if (!Number.isInteger(presetIndex)) return;

        this.engine.ensureAudioContext();
        this.loadPresetIndex(presetIndex);
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

  updateModeButtonStates() {
    const groups = [
      ['data-voice-mode', this.engine.params.voiceMode],
      ['data-sub-mode', this.engine.params.subMode],
      ['data-lfo-wave', this.engine.params.lfoWave],
      ['data-chorus-mode', this.engine.params.chorusMode]
    ];

    groups.forEach(([attribute, activeValue]) => {
      document.querySelectorAll(`[${attribute}]`).forEach((button) => {
        button.classList.toggle('active', button.getAttribute(attribute) === activeValue);
      });
    });
  }

  loadPresetIndex(idx) {
    const preset = window.S1_PRESETS[idx];
    if (!preset) return;

    this.engine.resetPatch();
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

    this.updateModeButtonStates();

    if (preset.pattern) {
      this.seq.loadPattern(preset.pattern);
      this.updateStepSelectKeysUI();
      this.updateNoteKeysHighlight();
      this.updatePageButtonsUI();
      this.updateAllKnobsVisual();
    }

    this.setDisplay(`P-${(idx + 1).toString().padStart(2, '0')}`, preset.name);
  }

  randomizePatternAndSound() {
    const choose = (values) => values[Math.floor(Math.random() * values.length)];
    const randomBetween = (min, max) => min + (Math.random() * (max - min));
    const randomExp = (min, max) => min * Math.pow(max / min, Math.random());
    const scale = [36, 39, 41, 43, 46, 48, 51, 53, 55, 58, 60, 63, 65, 67, 70, 72];

    const randomizedParams = {
      voiceMode: choose(['poly', 'mono', 'unison', 'chord']),
      chordType: choose(['maj', 'min', 'min7', 'maj7', 'sus4']),
      portamento: randomBetween(0, 0.18),
      oscSaw: randomBetween(0.25, 1),
      oscSquare: randomBetween(0.1, 1),
      oscPwm: randomBetween(0.15, 0.85),
      oscSub: randomBetween(0, 0.75),
      subMode: choose(['sub1', 'sub2', 'subPulse']),
      oscNoise: randomBetween(0, 0.18),
      oscDrawMix: randomBetween(0, 0.65),
      oscChop: Math.random() > 0.55 ? randomBetween(0.15, 0.8) : 0,
      oscChopComb: randomBetween(0.1, 0.7),
      filterCutoff: randomExp(350, 10000),
      filterResonance: randomBetween(0, 16),
      filterHpf: randomExp(10, 450),
      filterEnvDepth: randomBetween(-0.35, 0.9),
      filterKeyFollow: randomBetween(0.1, 0.9),
      drive: randomBetween(0, 0.45),
      envAttack: randomExp(0.003, 0.45),
      envDecay: randomExp(0.08, 1.8),
      envSustain: randomBetween(0.05, 0.8),
      envRelease: randomExp(0.08, 1.8),
      lfoRate: randomExp(0.15, 14),
      lfoWave: choose(['triangle', 'saw', 'square', 'sh']),
      lfoPitchDepth: randomBetween(0, 0.08),
      lfoFilterDepth: randomBetween(0, 0.35),
      lfoPwmDepth: randomBetween(0.1, 0.8),
      fxChorusSend: randomBetween(0, 0.65),
      chorusMode: choose(['off', 'type1', 'type2', 'type12']),
      fxDelaySend: randomBetween(0, 0.55),
      fxDelayTime: randomBetween(0.08, 0.65),
      fxDelayFeedback: randomBetween(0.1, 0.65),
      fxReverbSend: randomBetween(0, 0.65)
    };

    Object.entries(randomizedParams).forEach(([param, value]) => {
      const sanitized = this.sanitizeParameterValue(param, value, value);
      randomizedParams[param] = sanitized;
      this.engine.setParam(param, sanitized);
    });

    this.seq.clearPattern();
    for (let i = 0; i < this.seq.totalSteps; i++) {
      const step = this.seq.steps[i];
      if (Math.random() > 0.38) {
        step.notes.add(choose(scale));
        if (randomizedParams.voiceMode === 'poly' && Math.random() > 0.82) {
          step.notes.add(choose(scale));
        }
      }
      step.velocity = randomBetween(0.65, 1);
      step.substep = Math.random() > 0.86 ? choose([2, 3, 4]) : 1;
      step.probability = Math.random() > 0.82 ? choose([0.25, 0.5, 0.75]) : 1;
      const maxGateLength = 16 - (i % 16);
      step.gateLength = Math.random() > 0.9
        ? Math.min(choose([2, 3, 4]), maxGateLength)
        : 1;
    }

    this.updateModeButtonStates();
    this.updateAllKnobsVisual();
    this.updateStepSelectKeysUI();
    this.updateNoteKeysHighlight();
    this.setDisplay('rAnd', 'PATTERN & SOUND RANDOMIZED');
  }

  // =========================================================================
  // LOCAL SESSION PERSISTENCE
  // =========================================================================
  initPersistence() {
    const restored = this.restoreSession();
    if (restored) {
      this.markPresetAsRestoredSession();
      this.setDisplay('rStr', 'SESSION RESTORED');
    }

    const scheduleSave = () => this.scheduleSessionSave();
    document.addEventListener('pointerup', scheduleSave);
    document.addEventListener('click', scheduleSave);
    document.addEventListener('change', scheduleSave);
    document.addEventListener('wheel', (event) => {
      if (event.target.closest && event.target.closest('.rotary-knob')) scheduleSave();
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveSession();
    });
    window.addEventListener('beforeunload', () => this.saveSession());
  }

  scheduleSessionSave() {
    if (this.persistenceTimeout) window.clearTimeout(this.persistenceTimeout);
    this.persistenceTimeout = window.setTimeout(() => {
      this.persistenceTimeout = null;
      this.saveSession();
    }, 400);
  }

  getSessionState() {
    const motion = {};
    Object.entries(this.seq.motionData).forEach(([param, lane]) => {
      motion[param] = Array.from(lane);
    });

    return {
      version: 2,
      params: { ...this.engine.params },
      drawnWavePoints: Array.from(this.engine.drawnWavePoints),
      octave: this.currentOctave,
      editMode: this.seq.editMode,
      selectedStep: this.seq.selectedStep,
      pattern: {
        steps: this.seq.steps.map((step) => ({
          notes: Array.from(step.notes),
          velocity: step.velocity,
          probability: step.probability,
          gateLength: step.gateLength,
          substep: step.substep
        })),
        motion,
        pageLoop: {
          enabled: this.seq.isPageLoop,
          start: this.seq.pageLoopStart,
          end: this.seq.pageLoopEnd
        },
        currentPage: this.seq.currentPage
      }
    };
  }

  saveSession() {
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.getSessionState()));
    } catch (error) {
      console.warn('Unable to save S-1001 session:', error);
    }
  }

  sanitizeParameterValue(param, value, fallback = null) {
    const knob = document.querySelector(`.rotary-knob[data-param="${param}"]`);
    if (knob) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;

      const min = parseFloat(knob.dataset.min);
      const max = parseFloat(knob.dataset.max);
      const step = parseFloat(knob.dataset.step) || 0;
      let sanitized = Math.max(min, Math.min(max, value));
      if (step > 0) sanitized = Math.round(sanitized / step) * step;
      return sanitized;
    }

    const enumValues = {
      voiceMode: ['poly', 'mono', 'unison', 'chord'],
      chordType: ['maj', 'min', 'min7', 'maj7', 'sus4'],
      subMode: ['sub1', 'sub2', 'subPulse'],
      lfoWave: ['triangle', 'saw', 'square', 'sh'],
      chorusMode: ['off', 'type1', 'type2', 'type12']
    };
    return enumValues[param] && enumValues[param].includes(value) ? value : fallback;
  }

  sanitizeStoredPattern(pattern) {
    const sourceSteps = Array.isArray(pattern.steps) ? pattern.steps : [];
    const steps = Array.from({ length: this.seq.totalSteps }, (_, index) => {
      const source = sourceSteps[index];
      const step = source && typeof source === 'object' ? source : {};
      const notes = Array.isArray(step.notes)
        ? [...new Set(step.notes
          .filter((note) => Number.isInteger(note) && note >= 0 && note <= 127))]
        : [];
      const maxGateLength = 16 - (index % 16);
      const velocity = Number.isFinite(step.velocity) ? Math.max(0, Math.min(1, step.velocity)) : 0.9;
      const probability = Number.isFinite(step.probability) ? Math.max(0, Math.min(1, step.probability)) : 1;
      const gateLength = Number.isFinite(step.gateLength)
        ? Math.max(1, Math.min(maxGateLength, Math.round(step.gateLength)))
        : 1;
      const substep = Number.isFinite(step.substep)
        ? Math.max(1, Math.min(4, Math.round(step.substep)))
        : 1;

      return { notes, velocity, probability, gateLength, substep };
    });

    const motion = {};
    const sourceMotion = pattern.motion && typeof pattern.motion === 'object' ? pattern.motion : {};
    Object.keys(this.seq.motionData).forEach((param) => {
      const sourceLane = Array.isArray(sourceMotion[param]) ? sourceMotion[param] : [];
      motion[param] = Array.from({ length: this.seq.totalSteps }, (_, index) => {
        const value = sourceLane[index];
        if (value === null || value === undefined) return Number.NaN;
        const sanitized = this.sanitizeParameterValue(param, value, null);
        return typeof sanitized === 'number' ? sanitized : Number.NaN;
      });
    });

    const sourceLoop = pattern.pageLoop && typeof pattern.pageLoop === 'object'
      ? pattern.pageLoop
      : {};
    const start = Number.isInteger(sourceLoop.start) ? Math.max(0, Math.min(3, sourceLoop.start)) : 0;
    const end = Number.isInteger(sourceLoop.end) ? Math.max(0, Math.min(3, sourceLoop.end)) : start;
    const currentPage = Number.isInteger(pattern.currentPage)
      ? Math.max(0, Math.min(3, pattern.currentPage))
      : start;

    return {
      steps,
      motion,
      pageLoop: {
        enabled: typeof sourceLoop.enabled === 'boolean' ? sourceLoop.enabled : true,
        start: Math.min(start, end),
        end: Math.max(start, end)
      },
      currentPage
    };
  }

  restoreSession() {
    let state;
    try {
      const savedState = window.localStorage.getItem(this.storageKey);
      if (!savedState) return false;
      state = JSON.parse(savedState);
    } catch (error) {
      console.warn('Unable to restore S-1001 session:', error);
      return false;
    }

    if (!state || state.version !== 2 || !state.params || !state.pattern) return false;

    try {
      this.engine.resetPatch();
      Object.entries(state.params).forEach(([param, value]) => {
        if (!(param in this.engine.defaultParams)) return;
        const sanitized = this.sanitizeParameterValue(param, value, this.engine.defaultParams[param]);
        this.engine.setParam(param, sanitized);
      });

      if (Array.isArray(state.drawnWavePoints) && state.drawnWavePoints.length === 64) {
        const points = state.drawnWavePoints
          .map((value) => Number.isFinite(value) ? Math.max(-2, Math.min(2, value)) : 0);
        this.engine.setDrawnWaveform(new Float32Array(points));
      }

      const pattern = this.sanitizeStoredPattern(state.pattern);
      this.seq.loadPattern(pattern);
      this.seq.currentPage = pattern.currentPage;

      const validEditModes = ['note', 'prob', 'plock'];
      this.seq.editMode = validEditModes.includes(state.editMode) ? state.editMode : 'note';
      this.seq.isRecordingMotion = this.seq.editMode === 'plock';

      const selectedStep = state.selectedStep === null ? null : Number(state.selectedStep);
      this.seq.selectedStep = selectedStep !== null
        && Number.isInteger(selectedStep)
        && selectedStep >= 0
        && selectedStep < this.seq.totalSteps
        ? selectedStep
        : null;

      const octave = Number(state.octave);
      this.setOctave(Number.isFinite(octave) ? Math.round(octave) : 0, false);

      document.querySelectorAll('[data-step-edit-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.stepEditMode === this.seq.editMode);
      });
      this.updateModeButtonStates();
      this.updateAllKnobsVisual();
      this.updateStepSelectKeysUI();
      this.updateNoteKeysHighlight();
      this.updatePageButtonsUI();
      return true;
    } catch (error) {
      console.warn('Stored S-1001 session was invalid and has been ignored:', error);
      try { window.localStorage.removeItem(this.storageKey); } catch (storageError) {}
      return false;
    }
  }

  markPresetAsRestoredSession() {
    if (!this.presetSelect) return;

    let option = this.presetSelect.querySelector('option[value="session"]');
    if (!option) {
      option = document.createElement('option');
      option.value = 'session';
      option.textContent = 'RESTORED SESSION';
      this.presetSelect.prepend(option);
    }
    this.presetSelect.value = 'session';
  }

  setStepClearPending(pending) {
    this.isStepClearPending = pending;
    const clearButton = document.getElementById('btn-clear-step');
    if (clearButton) clearButton.classList.toggle('confirm-clear', pending);
    document.querySelectorAll('[data-step-edit-mode]').forEach((button) => {
      button.classList.toggle('clear-target', pending);
    });
  }

  clearSelectedStepData(type) {
    const stepIndex = this.seq.selectedStep;
    if (stepIndex === null) {
      this.setStepClearPending(false);
      this.setDisplay('NOSt', 'NO STEP SELECTED');
      return;
    }

    this.seq.invalidateQueuedPlayback();
    const step = this.seq.steps[stepIndex];
    if (type === 'note') {
      step.notes.clear();
      step.gateLength = 1;
      this.setDisplay('NCLr', `STEP ${stepIndex + 1} NOTES & GATE CLEARED`);
    } else if (type === 'plock') {
      Object.values(this.seq.motionData).forEach((lane) => {
        lane[stepIndex] = Number.NaN;
      });
      this.setDisplay('PCLr', `STEP ${stepIndex + 1} PARAMETER LOCKS CLEARED`);
    } else if (type === 'prob') {
      step.probability = 1;
      this.setDisplay('PrCL', `STEP ${stepIndex + 1} PROBABILITY RESET TO 100%`);
    }

    this.setStepClearPending(false);
    this.updateStepSelectKeysUI();
    this.updateNoteKeysHighlight();
    this.updateAllKnobsVisual();
    this.scheduleSessionSave();
  }

  setPatternClearPending(pending) {
    this.isPatternClearPending = pending;
    const clearButton = document.getElementById('btn-clear-all-pattern');
    if (clearButton) clearButton.classList.toggle('confirm-clear', pending);
  }

  // =========================================================================
  // TRANSPORT & SEQUENCER CONTROLS
  // =========================================================================
  initTransport() {
    const btnPlay = document.getElementById('btn-play');
    const btnStepLoop = document.getElementById('btn-step-loop');
    const btnArp = document.getElementById('btn-arp');

    btnPlay.addEventListener('click', () => {
      this.engine.ensureAudioContext();
      this.seq.togglePlay();
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
          this.updateAllKnobsVisual();

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
            this.updateAllKnobsVisual();

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
        if (this.isStepClearPending) {
          this.clearSelectedStepData(btn.dataset.stepEditMode);
          return;
        }

        editModeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.seq.editMode = btn.dataset.stepEditMode;
        this.seq.isRecordingMotion = (this.seq.editMode === 'plock');
        this.updateStepSelectKeysUI();
        this.updateNoteKeysHighlight();
        this.updateAllKnobsVisual();
        if (this.seq.editMode === 'prob') {
          this.setDisplay('PrOb', 'EDIT: PROBABILITY (CLICK A STEP TO VIEW/SET %)');
        } else if (this.seq.editMode === 'plock') {
          this.setDisplay('P-LC', 'EDIT: P-LOC (CLICK A STEP AND TWEAK KNOBS TO LOCK)');
        } else {
          this.setDisplay('NOtE', 'EDIT: NOTE / GATE LENGTH');
        }
      });
    });

    const btnClearStep = document.getElementById('btn-clear-step');
    const btnClearPattern = document.getElementById('btn-clear-all-pattern');
    const cancelClearModes = (event) => {
      const pressedControl = event.target.closest && event.target.closest('button, .step-key');
      if (!pressedControl) return;

      const isStepClearTarget = pressedControl.matches('[data-step-edit-mode]');
      if (this.isStepClearPending && pressedControl !== btnClearStep && !isStepClearTarget) {
        this.setStepClearPending(false);
        this.setDisplay('Abrt', 'STEP CLEAR ABORTED');
      }
      if (this.isPatternClearPending && pressedControl !== btnClearPattern) {
        this.setPatternClearPending(false);
        this.setDisplay('Abrt', 'CLEAR PATTERN ABORTED');
      }
    };

    document.addEventListener('pointerdown', cancelClearModes, true);
    document.addEventListener('click', cancelClearModes, true);

    btnClearStep.addEventListener('click', () => {
      this.engine.ensureAudioContext();

      if (this.isStepClearPending) {
        this.setStepClearPending(false);
        this.setDisplay('Abrt', 'STEP CLEAR CANCELED');
        return;
      }

      this.setStepClearPending(true);
      this.setDisplay('CLr?', 'CLEAR STEP: PRESS NOTE, P-LOC, OR PROB', true);
    });

    btnClearPattern.addEventListener('click', () => {
      this.engine.ensureAudioContext();

      if (!this.isPatternClearPending) {
        this.setPatternClearPending(true);
        this.setDisplay('CLr?', 'CLEAR ENTIRE PATTERN? PRESS CLR AGAIN', true);
        return;
      }

      this.setPatternClearPending(false);
      this.seq.clearPattern();
      this.updateStepSelectKeysUI();
      this.updateNoteKeysHighlight();
      this.updatePageButtonsUI();
      this.updateAllKnobsVisual();
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

      if (this.seq.selectedStep === null) {
        this.updateAllKnobsVisual(stepIdx);
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
        this.updateAllKnobsVisual();
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

      const inputSource = `pointer:${noteOffset}`;

      const playNote = () => {
        this.engine.ensureAudioContext();
        const midiNote = 60 + (this.currentOctave * 12) + noteOffset;
        this.pressedPointerNotes.set(inputSource, midiNote);
        this.engine.triggerNoteOn(midiNote, 0.9, null, inputSource);
        key.classList.add('key-pressed');
        this.pressedKeys.add(midiNote);
        this.seq.addArpHeldNote(midiNote, inputSource);
      };

      const releaseNote = () => {
        const midiNote = this.pressedPointerNotes.get(inputSource);
        if (midiNote === undefined) return;

        this.engine.triggerNoteOff(midiNote, null, inputSource);
        key.classList.remove('key-pressed');
        this.pressedKeys.delete(midiNote);
        this.pressedPointerNotes.delete(inputSource);
        this.seq.removeArpHeldNote(midiNote, inputSource);
      };

      key.addEventListener('pointerdown', (event) => {
        this.engine.ensureAudioContext();
        playNote();
        if (event.shiftKey) {
          const midiNote = 60 + (this.currentOctave * 12) + noteOffset;
          this.toggleNoteForSelectedStep(midiNote);
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
        this.updateAllKnobsVisual();

        const stepNum = (localIdx + 1).toString().padStart(2, '0');
        if (this.seq.editMode === 'note') {
          const gateLen = res && res.step ? (res.step.gateLength || 1) : 1;
          if (res && res.changed) {
            const dispGate = `G-${gateLen.toString().padStart(2, '0')}`;
            this.setDisplay(dispGate, `STEP ${stepNum} GATE LENGTH: ${gateLen} ${gateLen === 1 ? 'STEP' : 'STEPS'}`);
          } else {
            this.setDisplay(`Nt${stepNum}`, `STEP ${stepNum} SELECTED FOR NOTE ENTRY`);
          }
        } else if (this.seq.editMode === 'prob') {
          const pct = res && res.step ? Math.round(res.step.probability * 100) : 100;
          const dispPct = pct === 100 ? '100%' : `${pct}%`.padStart(4, ' ');
          this.setDisplay(dispPct, `STEP ${stepNum} PROBABILITY: ${pct}%`);
        } else if (this.seq.editMode === 'plock') {
          const hasPlocks = this.seq.getStepParams((this.seq.currentPage * 16) + localIdx);
          this.setDisplay(`PL${stepNum}`, `STEP ${stepNum} P-LOC ${hasPlocks ? '(LOCKED PARAMS LOADED)' : '(TWEAK KNOBS TO LOCK)'}`);
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

  toggleNoteForSelectedStep(midiNote) {
    const step = this.seq.toggleNoteOnSelectedStep(midiNote);
    if (!step) return false;

    this.updateNoteKeysHighlight();
    this.updateStepSelectKeysUI();
    this.scheduleSessionSave();
    return true;
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

    const inputId = event.target && event.target.id ? event.target.id : 'unknown';
    const midiSource = `midi:${inputId}:${status & 0x0f}`;

    if (command === 9 && velocity > 0) {
      this.engine.triggerNoteOn(note, velocity / 127, null, midiSource);
      this.seq.addArpHeldNote(note, midiSource);
    } else if (command === 8 || (command === 9 && velocity === 0)) {
      this.engine.triggerNoteOff(note, null, midiSource);
      this.seq.removeArpHeldNote(note, midiSource);
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
      if (this.engine.isStoppingRecording) return;

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
        this.setDisplay('SAVE', 'WAV READY');

        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = `Barnestorm_S1001_Jam_${Date.now()}.wav`;
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
