/**
 * Barnestorm S-1001 Tweak Synth - 64-Step Motion Sequencer & Arpeggiator
 * Web Audio clock-based lookahead scheduling, parameter locks, probability, and ratcheting
 */

class S1Sequencer {
  constructor(audioEngine) {
    this.engine = audioEngine;

    // Playback state
    this.isPlaying = false;
    this.isRecordingMotion = false;
    this.isStepLoop = false;
    this.isArpActive = false;

    // Sequencer dimensions
    this.totalSteps = 64;
    this.stepsPerPage = 16;
    this.currentPage = 0; // 0 (1-16), 1 (17-32), 2 (33-48), 3 (49-64)
    this.currentStep = 0; // 0 to 63

    // Step Loop Boundaries
    this.stepLoopStart = 0;
    this.stepLoopLength = 4;

    // Page Loop State (locked on Page 1-16 by default)
    this.isPageLoop = true;
    this.pageLoopStart = 0;
    this.pageLoopEnd = 0;

    // 64 Steps Data Storage
    this.steps = [];
    this.initSteps();

    // Currently selected step for note editing (global index 0-63, or null)
    this.selectedStep = null;

    // Motion Automation Lanes for all synth parameters
    this.motionData = {};
    const motionParams = [
      'oscSaw', 'oscSquare', 'oscPwm', 'oscSub', 'oscNoise', 'oscDrawMix', 'oscChop', 'oscChopComb',
      'filterCutoff', 'filterResonance', 'filterHpf', 'filterEnvDepth', 'filterKeyFollow', 'drive',
      'envAttack', 'envDecay', 'envSustain', 'envRelease',
      'lfoRate', 'lfoPitchDepth', 'lfoFilterDepth', 'lfoPwmDepth',
      'fxChorusSend', 'fxDelaySend', 'fxDelayTime', 'fxDelayFeedback', 'fxReverbSend',
      'portamento', 'masterVolume', 'tempo'
    ];
    motionParams.forEach(p => {
      this.motionData[p] = new Float64Array(64).fill(Number.NaN);
    });

    // Arpeggiator state
    this.arpHeldNotes = [];
    this.arpHeldNotesBySource = new Map();
    this.arpIndex = 0;
    this.arpMode = 'up';
    this.arpRate = 0.25;

    // Lookahead Clock Scheduler
    this.lookaheadMs = 25.0;
    this.scheduleAheadTime = 0.1;
    this.nextStepTime = 0.0;
    this.timerId = null;
    this.playbackGeneration = 0;
    this.activeSequencerNotes = new Set();

    // Step Edit Mode: 'note', 'prob', 'plock'
    this.editMode = 'note';

    // Callbacks for UI updates
    this.onStepTick = null;
    this.onPlayChange = null;
  }

  initSteps() {
    this.steps = [];
    for (let i = 0; i < this.totalSteps; i++) {
      this.steps.push({
        notes: new Set(), // MIDI note numbers that fire on this step
        velocity: 0.9,
        probability: 1.0,
        gateLength: 1, // 1 to 16 step gate length
        substep: 1
      });
    }
  }

  // =========================================================================
  // PAGE LOOP TOGGLE & MULTI-PAGE RANGE
  // =========================================================================
  togglePageLoop(pageIndex) {
    const targetPage = (pageIndex !== undefined) ? pageIndex : this.currentPage;

    if (!this.isPageLoop) {
      // First page loop: 1-page loop
      this.isPageLoop = true;
      this.pageLoopStart = targetPage;
      this.pageLoopEnd = targetPage;
      this.currentPage = targetPage;
    } else {
      // Page loop is already active
      if (this.pageLoopStart === targetPage && this.pageLoopEnd === targetPage) {
        // Double-tapping the only active loop page turns page loop OFF
        this.isPageLoop = false;
        return { isLooping: false, start: 0, end: 0 };
      } else if (targetPage >= this.pageLoopStart && targetPage <= this.pageLoopEnd && this.pageLoopStart !== this.pageLoopEnd) {
        // Double-tapping inside an existing multi-page range collapses to just this page
        this.pageLoopStart = targetPage;
        this.pageLoopEnd = targetPage;
        this.currentPage = targetPage;
      } else {
        // Double-tapping another page expands the loop range to include everything in between
        this.pageLoopStart = Math.min(this.pageLoopStart, targetPage);
        this.pageLoopEnd = Math.max(this.pageLoopEnd, targetPage);
        this.currentPage = targetPage;
      }
    }

    if (this.isPlaying && this.isPageLoop) {
      const loopStartStep = this.pageLoopStart * 16;
      const loopEndStep = (this.pageLoopEnd + 1) * 16;
      if (this.currentStep < loopStartStep || this.currentStep >= loopEndStep) {
        this.currentStep = loopStartStep;
      }
    }

    return { isLooping: this.isPageLoop, start: this.pageLoopStart, end: this.pageLoopEnd };
  }

  // =========================================================================
  // TRANSPORT & SCHEDULER
  // =========================================================================
  start() {
    if (this.isPlaying) return;
    this.engine.ensureAudioContext();

    this.isPlaying = true;
    this.playbackGeneration++;
    if (this.isStepLoop) {
      this.currentStep = this.stepLoopStart;
    } else if (this.isPageLoop) {
      this.currentStep = this.pageLoopStart * 16;
    } else {
      this.currentStep = 0;
    }
    this.nextStepTime = (this.engine.ctx ? this.engine.ctx.currentTime : 0) + 0.05;

    if (this.timerId) clearInterval(this.timerId);
    this.timerId = setInterval(() => this.scheduler(), this.lookaheadMs);

    if (this.onPlayChange) this.onPlayChange(true);
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.playbackGeneration++;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.releaseSequencerNotes();

    if (this.onPlayChange) this.onPlayChange(false);
  }

  togglePlay() {
    if (this.isPlaying) this.stop();
    else this.start();
  }

  scheduler() {
    if (!this.engine.ctx) return;
    while (this.nextStepTime < this.engine.ctx.currentTime + this.scheduleAheadTime) {
      this.scheduleStep(this.currentStep, this.nextStepTime);
      this.advanceStep();
    }
  }

  advanceStep() {
    const tempo = Math.max(30, Math.min(300, this.engine.params.tempo || 120));
    const secondsPerBeat = 60.0 / tempo;
    const stepDuration = secondsPerBeat * 0.25; // 16th note
    this.nextStepTime += stepDuration;

    if (this.isStepLoop) {
      const loopEnd = this.stepLoopStart + this.stepLoopLength;
      this.currentStep++;
      if (this.currentStep >= loopEnd || this.currentStep >= this.totalSteps) {
        this.currentStep = this.stepLoopStart;
      }
    } else if (this.isPageLoop) {
      const loopStartStep = this.pageLoopStart * 16;
      const loopEndStep = (this.pageLoopEnd + 1) * 16;
      this.currentStep++;
      if (this.currentStep < loopStartStep || this.currentStep >= loopEndStep) {
        this.currentStep = loopStartStep;
      }
    } else {
      this.currentStep = (this.currentStep + 1) % this.totalSteps;
    }
  }

  scheduleStep(stepIdx, time) {
    const step = this.steps[stepIdx];
    if (!step) return;

    const tempo = Math.max(30, Math.min(300, this.engine.params.tempo || 120));
    const secondsPerBeat = 60.0 / tempo;
    const stepDuration = secondsPerBeat * 0.25;

    // Collect any per-step motion automated parameters
    const stepParams = this.getStepParams(stepIdx);

    // Notify UI (highlight chase LED and step)
    const pageOfStep = Math.floor(stepIdx / 16);
    const localStepIdx = stepIdx % 16;
    const delayMs = Math.max(0, (time - (this.engine.ctx ? this.engine.ctx.currentTime : 0)) * 1000);

    setTimeout(() => {
      if (this.onStepTick && this.isPlaying) {
        this.onStepTick(stepIdx, localStepIdx, pageOfStep, step.notes.size > 0);
      }
    }, delayMs);

    // Handle Arpeggiator
    if (this.isArpActive && this.arpHeldNotes.length > 0) {
      this.scheduleArpStep(time, stepDuration);
      return;
    }

    // Step Playback Gate & Probability Check
    if (step.notes.size === 0) return;
    if (step.probability < 1.0 && Math.random() > step.probability) {
      return;
    }

    const notes = Array.from(step.notes);
    const velocity = step.velocity || 0.9;
    const sub = step.substep || 1;
    const gateLen = Math.max(1, Math.min(16, step.gateLength || 1));

    if (sub === 1) {
      const noteDuration = (stepDuration * gateLen) * 0.85;
      notes.forEach(note => this.triggerScheduledNote(note, velocity, time, noteDuration, stepParams));
    } else {
      const subDuration = (stepDuration * gateLen) / sub;
      for (let s = 0; s < sub; s++) {
        const subTime = time + (s * (stepDuration / sub));
        const subVelocity = velocity * (s === 0 ? 1.0 : 0.8);
        notes.forEach(note => this.triggerScheduledNote(note, subVelocity, subTime, subDuration * 0.75, stepParams));
      }
    }
  }

  triggerScheduledNote(note, velocity, time, duration, stepParams = null) {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const delayFromNow = Math.max(0, time - ctx.currentTime);
    const releaseTime = (stepParams && stepParams.envRelease !== undefined) ? stepParams.envRelease : null;
    const generation = this.playbackGeneration;

    window.setTimeout(() => {
      if (this.isPlaying && generation === this.playbackGeneration) {
        this.engine.triggerNoteOn(note, velocity, stepParams, 'sequencer');
        this.activeSequencerNotes.add(note);
      }
    }, delayFromNow * 1000);

    window.setTimeout(() => {
      if (this.isPlaying && generation === this.playbackGeneration) {
        this.engine.triggerNoteOff(note, releaseTime, 'sequencer');
        this.activeSequencerNotes.delete(note);
      }
    }, (delayFromNow + duration) * 1000);
  }

  // =========================================================================
  // MOTION RECORDING & PER-STEP AUTOMATION
  // =========================================================================
  getStepParams(stepIdx) {
    if (stepIdx === null || stepIdx === undefined || stepIdx < 0 || stepIdx >= this.totalSteps) return null;
    const stepParams = {};
    let hasParam = false;
    for (const [param, lane] of Object.entries(this.motionData)) {
      const val = lane[stepIdx];
      if (Number.isFinite(val)) {
        stepParams[param] = val;
        hasParam = true;
      }
    }
    return hasParam ? stepParams : null;
  }

  recordMotion(paramName, value) {
    // Continuous live motion recording disabled: P-Locks only apply to explicitly selected step
    return;
  }

  getStepParam(stepIdx, paramName) {
    if (stepIdx === null || stepIdx === undefined || stepIdx < 0 || stepIdx >= this.totalSteps) return null;
    const lane = this.motionData[paramName];
    if (lane && Number.isFinite(lane[stepIdx])) {
      return lane[stepIdx];
    }
    return null;
  }

  setStepParam(stepIdx, paramName, value) {
    if (stepIdx === null || stepIdx === undefined || stepIdx < 0 || stepIdx >= this.totalSteps) return;
    if (!this.motionData[paramName]) {
      this.motionData[paramName] = new Float64Array(64).fill(Number.NaN);
    }
    this.motionData[paramName][stepIdx] = value;
  }

  applyMotion(stepIdx, time) {
    for (const [param, lane] of Object.entries(this.motionData)) {
      const val = lane[stepIdx];
      if (Number.isFinite(val)) {
        this.engine.setParam(param, val);
      }
    }
  }

  clearMotion() {
    for (const param in this.motionData) {
      this.motionData[param].fill(Number.NaN);
    }
  }

  // =========================================================================
  // ARPEGGIATOR
  // =========================================================================
  setArpHeldNotes(notes, source = 'default') {
    this.arpHeldNotesBySource.set(source, new Set(notes));
    this.refreshArpHeldNotes();
  }

  addArpHeldNote(note, source = 'default') {
    const sourceNotes = this.arpHeldNotesBySource.get(source) || new Set();
    sourceNotes.add(note);
    this.arpHeldNotesBySource.set(source, sourceNotes);
    this.refreshArpHeldNotes();
  }

  removeArpHeldNote(note, source = 'default') {
    const sourceNotes = this.arpHeldNotesBySource.get(source);
    if (sourceNotes) {
      sourceNotes.delete(note);
      if (sourceNotes.size === 0) this.arpHeldNotesBySource.delete(source);
    }
    this.refreshArpHeldNotes();
  }

  refreshArpHeldNotes() {
    const allNotes = new Set();
    this.arpHeldNotesBySource.forEach((notes) => {
      notes.forEach((note) => allNotes.add(note));
    });
    this.arpHeldNotes = [...allNotes].sort((a, b) => a - b);
    if (this.arpIndex >= this.arpHeldNotes.length) {
      this.arpIndex = 0;
    }
  }

  scheduleArpStep(time, stepDuration) {
    if (this.arpHeldNotes.length === 0) return;

    let noteToPlay = this.arpHeldNotes[0];
    if (this.arpMode === 'up') {
      noteToPlay = this.arpHeldNotes[this.arpIndex % this.arpHeldNotes.length];
      this.arpIndex = (this.arpIndex + 1) % this.arpHeldNotes.length;
    } else if (this.arpMode === 'down') {
      const rev = [...this.arpHeldNotes].reverse();
      noteToPlay = rev[this.arpIndex % rev.length];
      this.arpIndex = (this.arpIndex + 1) % rev.length;
    } else if (this.arpMode === 'random') {
      noteToPlay = this.arpHeldNotes[Math.floor(Math.random() * this.arpHeldNotes.length)];
    }

    this.triggerScheduledNote(noteToPlay, 0.85, time, stepDuration * 0.8);
  }

  // =========================================================================
  // STEP EDITING & PATTERN MODIFICATIONS
  // =========================================================================
  // Pressing a STEP SELECT key selects it for the active edit mode. Repeated
  // presses change gate length in NOTE mode or probability in PROB mode.
  handleStepSelectPress(localIndex) {
    const stepIdx = (this.currentPage * 16) + localIndex;
    const step = this.steps[stepIdx];
    if (!step) return null;

    let changed = false;

    if (this.editMode === 'prob') {
      if (this.selectedStep === stepIdx) {
        // Step is already selected: cycle probability
        if (step.probability === 1.0) step.probability = 0.75;
        else if (step.probability === 0.75) step.probability = 0.50;
        else if (step.probability === 0.50) step.probability = 0.25;
        else step.probability = 1.0;
        changed = true;
      } else {
        // First click: select and inspect without modifying
        this.selectedStep = stepIdx;
        changed = false;
      }
    } else if (this.editMode === 'plock') {
      // P-LOC mode: select step to inspect & tweak parameter locks
      if (this.selectedStep === stepIdx) {
        changed = false;
      } else {
        this.selectedStep = stepIdx;
        changed = false;
      }
    } else {
      // NOTE mode selects the step for note entry; repeated presses cycle gate length.
      if (this.selectedStep === stepIdx) {
        const localPos = stepIdx % 16;
        const maxGate = 16 - localPos;
        const curGate = step.gateLength || 1;
        step.gateLength = (curGate >= maxGate) ? 1 : (curGate + 1);
        changed = true;
      } else {
        this.selectedStep = stepIdx;
      }
    }

    return { stepIdx, step, selectedStep: this.selectedStep, changed };
  }

  // Pressing a NOTE key while a step is selected adds/removes that note
  // from the selected step's chord. No-op if no step is selected.
  toggleNoteOnSelectedStep(midiNote) {
    if (this.editMode !== 'note' || this.selectedStep === null) return null;
    const step = this.steps[this.selectedStep];
    if (!step) return null;

    if (step.notes.has(midiNote)) {
      step.notes.delete(midiNote);
      if (step.notes.size === 0) step.gateLength = 1;
    } else {
      step.notes.add(midiNote);
    }
    return step;
  }

  releaseSequencerNotes() {
    this.activeSequencerNotes.forEach((note) => {
      this.engine.triggerNoteOff(note, null, 'sequencer');
    });
    this.activeSequencerNotes.clear();
  }

  invalidateQueuedPlayback() {
    this.playbackGeneration++;
    this.releaseSequencerNotes();
  }

  clearPattern() {
    this.invalidateQueuedPlayback();
    this.initSteps();
    this.clearMotion();
    this.selectedStep = null;
  }

  loadPattern(patternData) {
    if (!patternData) return;

    // A loaded pattern is a complete replacement, not a partial overlay.
    this.invalidateQueuedPlayback();
    this.initSteps();
    this.clearMotion();
    this.selectedStep = null;

    if (patternData.steps) {
      for (let i = 0; i < Math.min(patternData.steps.length, this.totalSteps); i++) {
        const src = patternData.steps[i];
        const notes = new Set();
        if (src.notes) {
          (Array.isArray(src.notes) ? src.notes : Array.from(src.notes)).forEach(n => notes.add(n));
        } else if (src.gate && src.note !== undefined) {
          // Legacy single-note-per-step preset format
          notes.add(src.note);
        }
        this.steps[i] = {
          notes,
          velocity: src.velocity !== undefined ? src.velocity : this.steps[i].velocity,
          probability: src.probability !== undefined ? src.probability : this.steps[i].probability,
          gateLength: src.gateLength !== undefined ? src.gateLength : (src.length || 1),
          substep: src.substep !== undefined ? src.substep : this.steps[i].substep
        };
      }
    }
    if (patternData.motion) {
      for (const [key, values] of Object.entries(patternData.motion)) {
        if (this.motionData[key]) {
          this.motionData[key].set(values);
        }
      }
    }
    // Page Loop / Page Lock settings saved with pattern
    if (patternData.pageLoop !== undefined) {
      if (typeof patternData.pageLoop === 'boolean') {
        this.isPageLoop = patternData.pageLoop;
        this.pageLoopStart = patternData.pageLoopStart !== undefined ? patternData.pageLoopStart : 0;
        this.pageLoopEnd = patternData.pageLoopEnd !== undefined ? patternData.pageLoopEnd : 0;
      } else if (typeof patternData.pageLoop === 'object') {
        this.isPageLoop = patternData.pageLoop.enabled !== undefined ? patternData.pageLoop.enabled : true;
        this.pageLoopStart = patternData.pageLoop.start !== undefined ? patternData.pageLoop.start : 0;
        this.pageLoopEnd = patternData.pageLoop.end !== undefined ? patternData.pageLoop.end : 0;
      }
    } else {
      // Default: locked on Page 1 (1-16)
      this.isPageLoop = true;
      this.pageLoopStart = 0;
      this.pageLoopEnd = 0;
    }
    this.currentPage = patternData.currentPage !== undefined ? patternData.currentPage : this.pageLoopStart;
  }
}

window.S1Sequencer = S1Sequencer;
