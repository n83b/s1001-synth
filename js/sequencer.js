/**
 * Roland AIRA Compact S-1 Tweak Synth - 64-Step Motion Sequencer & Arpeggiator
 * Zero-jitter Web Audio lookahead scheduling, motion parameter lanes, probability & ratcheting
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
    this.stepLoopLength = 4; // 4 steps default loop

    // 64 Steps Data Storage
    this.steps = [];
    this.initSteps();

    // Motion Automation Lanes (Record parameter changes per step)
    this.motionData = {
      filterCutoff: new Float32Array(64).fill(-1),
      filterResonance: new Float32Array(64).fill(-1),
      oscChop: new Float32Array(64).fill(-1),
      oscDrawMix: new Float32Array(64).fill(-1),
      drive: new Float32Array(64).fill(-1)
    };

    // Arpeggiator state
    this.arpHeldNotes = [];
    this.arpIndex = 0;
    this.arpMode = 'up'; // up, down, updown, random, chord
    this.arpRate = 0.25; // 1/16th

    // Lookahead Clock Scheduler
    this.lookaheadMs = 25.0; // Interval for scheduler tick
    this.scheduleAheadTime = 0.1; // Schedule audio 100ms in advance
    this.nextStepTime = 0.0;
    this.timerId = null;

    // Step Edit Mode: 'gate', 'pitch', 'prob', 'ratchet'
    this.editMode = 'gate';

    // Callbacks for UI updates
    this.onStepTick = null;
    this.onPlayChange = null;
  }

  initSteps() {
    this.steps = [];
    for (let i = 0; i < this.totalSteps; i++) {
      this.steps.push({
        gate: false,
        note: 60, // C4
        velocity: 0.9,
        probability: 1.0, // 100%
        substep: 1 // 1=single, 2=flam, 3=triplet, 4=quad
      });
    }
  }

  // =========================================================================
  // TRANSPORT & SCHEDULER
  // =========================================================================
  start() {
    if (this.isPlaying) return;
    this.engine.init();

    this.isPlaying = true;
    this.currentStep = this.isStepLoop ? this.stepLoopStart : (this.currentPage * 16);
    this.nextStepTime = this.engine.ctx.currentTime + 0.05;

    this.timerId = setInterval(() => this.scheduler(), this.lookaheadMs);

    if (this.onPlayChange) this.onPlayChange(true);
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.engine.allNotesOff();

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
    const secondsPerBeat = 60.0 / this.engine.params.tempo;
    const stepDuration = secondsPerBeat * 0.25; // 16th note
    this.nextStepTime += stepDuration;

    if (this.isStepLoop) {
      // Loop within sliced step window
      const loopEnd = this.stepLoopStart + this.stepLoopLength;
      this.currentStep++;
      if (this.currentStep >= loopEnd || this.currentStep >= this.totalSteps) {
        this.currentStep = this.stepLoopStart;
      }
    } else {
      // Normal 64-step progression
      this.currentStep = (this.currentStep + 1) % this.totalSteps;
    }
  }

  scheduleStep(stepIdx, time) {
    const step = this.steps[stepIdx];
    const secondsPerBeat = 60.0 / this.engine.params.tempo;
    const stepDuration = secondsPerBeat * 0.25;

    // Apply Motion Automation if recorded
    this.applyMotion(stepIdx, time);

    // Notify UI (highlight chase LED and step)
    const pageOfStep = Math.floor(stepIdx / 16);
    const localStepIdx = stepIdx % 16;

    setTimeout(() => {
      if (this.onStepTick) {
        this.onStepTick(stepIdx, localStepIdx, pageOfStep, step.gate);
      }
    }, Math.max(0, (time - this.engine.ctx.currentTime) * 1000));

    // Handle Arpeggiator if active
    if (this.isArpActive && this.arpHeldNotes.length > 0) {
      this.scheduleArpStep(time, stepDuration);
      return;
    }

    // Step Playback Gate & Probability Check
    if (!step.gate) return;
    if (step.probability < 1.0 && Math.random() > step.probability) {
      return; // Skip step on failed probability roll
    }

    const note = step.note;
    const velocity = step.velocity;
    const sub = step.substep;

    if (sub === 1) {
      // Standard Single Note Trigger
      this.triggerScheduledNote(note, velocity, time, stepDuration * 0.85);
    } else {
      // Flam / Ratchet / Substep Triggers
      const subDuration = stepDuration / sub;
      for (let s = 0; s < sub; s++) {
        const subTime = time + (s * subDuration);
        this.triggerScheduledNote(note, velocity * (s === 0 ? 1.0 : 0.8), subTime, subDuration * 0.75);
      }
    }
  }

  triggerScheduledNote(note, velocity, time, duration) {
    const ctx = this.engine.ctx;
    const delayFromNow = Math.max(0, time - ctx.currentTime);

    setTimeout(() => {
      if (this.isPlaying) {
        this.engine.triggerNoteOn(note, velocity);
      }
    }, delayFromNow * 1000);

    setTimeout(() => {
      if (this.isPlaying) {
        this.engine.triggerNoteOff(note);
      }
    }, (delayFromNow + duration) * 1000);
  }

  // =========================================================================
  // MOTION RECORDING & AUTOMATION
  // =========================================================================
  recordMotion(paramName, value) {
    if (!this.isRecordingMotion || !this.isPlaying) return;
    if (this.motionData[paramName]) {
      this.motionData[paramName][this.currentStep] = value;
    }
  }

  applyMotion(stepIdx, time) {
    for (const [param, lane] of Object.entries(this.motionData)) {
      const val = lane[stepIdx];
      if (val !== -1 && val !== undefined) {
        this.engine.setParam(param, val);
      }
    }
  }

  clearMotion() {
    for (const param in this.motionData) {
      this.motionData[param].fill(-1);
    }
  }

  // =========================================================================
  // ARPEGGIATOR
  // =========================================================================
  setArpHeldNotes(notes) {
    this.arpHeldNotes = [...notes].sort((a, b) => a - b);
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
  toggleStep(localIndex, currentOctaveNote = 60) {
    const stepIdx = (this.currentPage * 16) + localIndex;
    const step = this.steps[stepIdx];

    if (this.editMode === 'gate') {
      step.gate = !step.gate;
      if (step.gate) {
        step.note = currentOctaveNote;
      }
    } else if (this.editMode === 'pitch') {
      step.note = currentOctaveNote;
      step.gate = true;
    } else if (this.editMode === 'prob') {
      // Cycle probabilities: 1.0 -> 0.75 -> 0.5 -> 0.25 -> 1.0
      if (step.probability === 1.0) step.probability = 0.75;
      else if (step.probability === 0.75) step.probability = 0.50;
      else if (step.probability === 0.50) step.probability = 0.25;
      else step.probability = 1.0;
    } else if (this.editMode === 'ratchet') {
      // Cycle flam/ratchet sub-steps: 1 -> 2 (flam) -> 3 (triplet) -> 4 (quad) -> 1
      step.substep = (step.substep % 4) + 1;
    }

    return step;
  }

  clearPattern() {
    this.initSteps();
    this.clearMotion();
  }

  loadPattern(patternData) {
    if (!patternData) return;
    if (patternData.steps) {
      for (let i = 0; i < Math.min(patternData.steps.length, this.totalSteps); i++) {
        this.steps[i] = { ...this.steps[i], ...patternData.steps[i] };
      }
    }
    if (patternData.motion) {
      for (const [key, values] of Object.entries(patternData.motion)) {
        if (this.motionData[key]) {
          this.motionData[key].set(values);
        }
      }
    }
  }
}

window.S1Sequencer = S1Sequencer;
