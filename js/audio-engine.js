/**
 * Roland AIRA Compact S-1 Tweak Synth - Web Audio Sound Engine
 * 4-Voice Polyphonic ACB Modeling with OSC Draw, OSC Chop, Resonant 24dB VCF & Roland FX Chain
 */

class S1AudioEngine {
  constructor() {
    this.ctx = null;
    this.isInitialized = false;
    this.isMuted = false;

    // Master Parameters
    this.params = {
      masterVolume: 0.8,
      tempo: 120,
      portamento: 0.0,
      voiceMode: 'poly', // poly, mono, unison, chord
      chordType: 'min7', // maj, min, min7, maj7, sus4

      // Oscillators
      oscSaw: 0.8,
      oscSquare: 0.8,
      oscPwm: 0.5,
      oscSub: 0.3,
      subMode: 'sub1', // sub1 (-1 oct), sub2 (-2 oct), subPulse
      oscNoise: 0.0,
      oscDrawMix: 0.0,
      oscChop: 0.0,
      oscChopComb: 0.2,

      // Filter
      filterCutoff: 4500,
      filterResonance: 4.0,
      filterHpf: 10,
      filterEnvDepth: 0.5,
      filterKeyFollow: 0.5,
      drive: 0.1,

      // Envelopes
      envAttack: 0.005,
      envDecay: 0.35,
      envSustain: 0.2,
      envRelease: 0.4,

      // LFO
      lfoRate: 3.0,
      lfoWave: 'triangle', // triangle, saw, square, sh
      lfoPitchDepth: 0.0,
      lfoFilterDepth: 0.0,
      lfoPwmDepth: 0.25,

      // FX
      fxChorusSend: 0.4,
      chorusMode: 'type1', // off, type1, type2, type12
      fxDelaySend: 0.25,
      fxDelayTime: 0.375,
      fxDelayFeedback: 0.4,
      fxReverbSend: 0.3
    };

    // Drawn Waveform Points (Default Sine)
    this.drawnWavePoints = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
      this.drawnWavePoints[i] = Math.sin((i / 64) * Math.PI * 2);
    }
    this.customPeriodicWave = null;

    // Voice pool (4 Voices)
    this.maxVoices = 4;
    this.voices = [];
    this.activeVoiceMap = new Map(); // note -> voice
    this.lastMonoNote = null;
    this.lastMonoFreq = 440;

    // Recording buffer
    this.recorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    // Callbacks
    this.onNoteTrigger = null;
  }

  async init() {
    if (this.isInitialized) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx({ latencyHint: 'interactive' });

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Build Master Bus & Effects Chain
    this.setupAudioGraph();

    // Generate Custom Periodic Wave
    this.updateCustomPeriodicWave();

    // Create Noise Buffer
    this.createNoiseBuffer();

    // Initialize 4 Polyphonic Voices
    for (let i = 0; i < this.maxVoices; i++) {
      this.voices.push(new S1Voice(this, i));
    }

    this.isInitialized = true;
  }

  setupAudioGraph() {
    // Synth Voice Bus
    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1.0;

    // Master Drive / Waveshaper
    this.driveNode = this.ctx.createWaveShaper();
    this.updateDriveCurve();

    // Master Volume Gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.params.masterVolume;

    // Master Compressor / Limiter
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-1.0, this.ctx.currentTime);
    this.limiter.knee.setValueAtTime(4.0, this.ctx.currentTime);
    this.limiter.ratio.setValueAtTime(16.0, this.ctx.currentTime);
    this.limiter.attack.setValueAtTime(0.002, this.ctx.currentTime);
    this.limiter.release.setValueAtTime(0.1, this.ctx.currentTime);

    // Master Analyser (for Oscilloscope)
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // Setup FX Chain
    this.setupChorus();
    this.setupDelay();
    this.setupReverb();

    // Recording Destination
    this.recDestination = this.ctx.createMediaStreamDestination();

    // Wiring Audio Graph
    // VoiceBus -> Drive -> MasterGain -> Split to FX & Dry
    this.voiceBus.connect(this.driveNode);
    this.driveNode.connect(this.masterGain);

    // Dry path
    this.masterGain.connect(this.limiter);

    // FX sends
    this.masterGain.connect(this.chorusInput);
    this.masterGain.connect(this.delayInput);
    this.masterGain.connect(this.reverbInput);

    // FX returns -> Limiter
    this.chorusOutput.connect(this.limiter);
    this.delayOutput.connect(this.limiter);
    this.reverbOutput.connect(this.limiter);

    // Limiter -> Analyser -> Output & Recorder
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.analyser.connect(this.recDestination);
  }

  updateDriveCurve() {
    const k = this.params.drive * 30;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      if (k === 0) {
        curve[i] = x;
      } else {
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
      }
    }
    this.driveNode.curve = curve;
  }

  createNoiseBuffer() {
    const bufferSize = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
  }

  // =========================================================================
  // EFFECTS PROCESSORS
  // =========================================================================
  setupChorus() {
    this.chorusInput = this.ctx.createGain();
    this.chorusOutput = this.ctx.createGain();
    this.chorusGain = this.ctx.createGain();
    this.chorusGain.gain.value = this.params.fxChorusSend;

    // Stereo BBD Delay Lines
    this.chorusDelayL = this.ctx.createDelay();
    this.chorusDelayR = this.ctx.createDelay();
    this.chorusDelayL.delayTime.value = 0.007; // 7ms
    this.chorusDelayR.delayTime.value = 0.009; // 9ms

    // Dual Chorus LFOs (Roland Juno I / II style)
    this.chorusLfoL = this.ctx.createOscillator();
    this.chorusLfoR = this.ctx.createOscillator();
    this.chorusLfoDepthL = this.ctx.createGain();
    this.chorusLfoDepthR = this.ctx.createGain();

    this.chorusLfoL.frequency.value = 0.5; // Juno Type I ~0.5Hz
    this.chorusLfoR.frequency.value = 0.8; // Juno Type II ~0.8Hz
    this.chorusLfoDepthL.gain.value = 0.0025;
    this.chorusLfoDepthR.gain.value = 0.0035;

    this.chorusLfoL.connect(this.chorusLfoDepthL);
    this.chorusLfoR.connect(this.chorusLfoDepthR);
    this.chorusLfoDepthL.connect(this.chorusDelayL.delayTime);
    this.chorusLfoDepthR.connect(this.chorusDelayR.delayTime);

    this.chorusLfoL.start();
    this.chorusLfoR.start();

    // Stereo Merger
    const merger = this.ctx.createChannelMerger(2);
    this.chorusInput.connect(this.chorusDelayL);
    this.chorusInput.connect(this.chorusDelayR);
    this.chorusDelayL.connect(merger, 0, 0);
    this.chorusDelayR.connect(merger, 0, 1);

    merger.connect(this.chorusGain);
    this.chorusGain.connect(this.chorusOutput);
    this.updateChorusMode();
  }

  updateChorusMode() {
    const mode = this.params.chorusMode;
    if (mode === 'off') {
      this.chorusGain.gain.setValueAtTime(0, this.ctx.currentTime);
    } else if (mode === 'type1') {
      this.chorusLfoL.frequency.setValueAtTime(0.5, this.ctx.currentTime);
      this.chorusLfoR.frequency.setValueAtTime(0.5, this.ctx.currentTime);
      this.chorusLfoDepthL.gain.setValueAtTime(0.002, this.ctx.currentTime);
      this.chorusLfoDepthR.gain.setValueAtTime(0.0025, this.ctx.currentTime);
      this.chorusGain.gain.setValueAtTime(this.params.fxChorusSend, this.ctx.currentTime);
    } else if (mode === 'type2') {
      this.chorusLfoL.frequency.setValueAtTime(0.9, this.ctx.currentTime);
      this.chorusLfoR.frequency.setValueAtTime(0.95, this.ctx.currentTime);
      this.chorusLfoDepthL.gain.setValueAtTime(0.0035, this.ctx.currentTime);
      this.chorusLfoDepthR.gain.setValueAtTime(0.004, this.ctx.currentTime);
      this.chorusGain.gain.setValueAtTime(this.params.fxChorusSend * 1.2, this.ctx.currentTime);
    } else if (mode === 'type12') {
      this.chorusLfoL.frequency.setValueAtTime(1.4, this.ctx.currentTime);
      this.chorusLfoR.frequency.setValueAtTime(1.5, this.ctx.currentTime);
      this.chorusLfoDepthL.gain.setValueAtTime(0.0045, this.ctx.currentTime);
      this.chorusLfoDepthR.gain.setValueAtTime(0.005, this.ctx.currentTime);
      this.chorusGain.gain.setValueAtTime(this.params.fxChorusSend * 1.3, this.ctx.currentTime);
    }
  }

  setupDelay() {
    this.delayInput = this.ctx.createGain();
    this.delayOutput = this.ctx.createGain();
    this.delayGain = this.ctx.createGain();
    this.delayGain.gain.value = this.params.fxDelaySend;

    this.delayNode = this.ctx.createDelay(2.0);
    this.delayNode.delayTime.value = this.params.fxDelayTime;

    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = this.params.fxDelayFeedback;

    // Lowpass filter for analog tape damping
    this.delayFilter = this.ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 3500;

    this.delayInput.connect(this.delayNode);
    this.delayNode.connect(this.delayFilter);
    this.delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayFilter.connect(this.delayGain);
    this.delayGain.connect(this.delayOutput);
  }

  setupReverb() {
    this.reverbInput = this.ctx.createGain();
    this.reverbOutput = this.ctx.createGain();
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = this.params.fxReverbSend;

    // Convolution Reverb with Algorithmic Synthetic Impulse Response
    this.convolver = this.ctx.createConvolver();
    this.generateReverbImpulse(2.5, 2.0);

    this.reverbInput.connect(this.convolver);
    this.convolver.connect(this.reverbGain);
    this.reverbGain.connect(this.reverbOutput);
  }

  generateReverbImpulse(duration, decay) {
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = this.ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = length - i;
      const factor = Math.pow(n / length, decay);
      left[i] = (Math.random() * 2 - 1) * factor;
      right[i] = (Math.random() * 2 - 1) * factor;
    }
    this.convolver.buffer = impulse;
  }

  // =========================================================================
  // OSC DRAW / FOURIER SYNTHESIS
  // =========================================================================
  setDrawnWaveform(points) {
    this.drawnWavePoints = points;
    this.updateCustomPeriodicWave();
  }

  updateCustomPeriodicWave() {
    if (!this.ctx) return;
    const numHarmonics = 64;
    const real = new Float32Array(numHarmonics);
    const imag = new Float32Array(numHarmonics);
    const N = this.drawnWavePoints.length;

    // Compute Discrete Fourier Transform (DFT) of custom wave
    for (let k = 1; k < numHarmonics; k++) {
      let sumReal = 0;
      let sumImag = 0;
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        sumReal += this.drawnWavePoints[n] * Math.cos(angle);
        sumImag += this.drawnWavePoints[n] * Math.sin(angle);
      }
      real[k] = sumReal / N;
      imag[k] = -sumImag / N;
    }

    try {
      this.customPeriodicWave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
      this.voices.forEach(v => v.updatePeriodicWave(this.customPeriodicWave));
    } catch (e) {
      console.warn('PeriodicWave creation warning:', e);
    }
  }

  // =========================================================================
  // PARAMETER UPDATES
  // =========================================================================
  setParam(name, value) {
    this.params[name] = value;
    const now = this.ctx ? this.ctx.currentTime : 0;

    switch (name) {
      case 'masterVolume':
        if (this.masterGain && this.ctx) {
          this.masterGain.gain.setTargetAtTime(value, now, 0.02);
        }
        break;
      case 'drive':
        this.updateDriveCurve();
        break;
      case 'fxChorusSend':
        if (this.chorusGain && this.ctx) {
          this.chorusGain.gain.setTargetAtTime(value, now, 0.02);
        }
        break;
      case 'chorusMode':
        this.updateChorusMode();
        break;
      case 'fxDelaySend':
        if (this.delayGain && this.ctx) {
          this.delayGain.gain.setTargetAtTime(value, now, 0.02);
        }
        break;
      case 'fxDelayTime':
        if (this.delayNode && this.ctx) {
          this.delayNode.delayTime.setTargetAtTime(value, now, 0.05);
        }
        break;
      case 'fxDelayFeedback':
        if (this.delayFeedback && this.ctx) {
          this.delayFeedback.gain.setTargetAtTime(value, now, 0.02);
        }
        break;
      case 'fxReverbSend':
        if (this.reverbGain && this.ctx) {
          this.reverbGain.gain.setTargetAtTime(value, now, 0.02);
        }
        break;
      default:
        // Update voice parameters in real-time
        this.voices.forEach(v => v.updateParam(name, value));
        break;
    }
  }

  // =========================================================================
  // NOTE HANDLING & VOICE ALLOCATION
  // =========================================================================
  midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  triggerNoteOn(midiNote, velocity = 1.0) {
    if (!this.isInitialized) {
      this.init();
    }
    if (this.isMuted) return;

    const baseFreq = this.midiToFreq(midiNote);
    const mode = this.params.voiceMode;

    if (mode === 'mono') {
      const voice = this.voices[0];
      const prevFreq = this.lastMonoFreq || baseFreq;
      voice.triggerOn(midiNote, baseFreq, velocity, prevFreq, this.params.portamento);
      this.lastMonoNote = midiNote;
      this.lastMonoFreq = baseFreq;
      this.activeVoiceMap.set(midiNote, voice);
    } 
    else if (mode === 'unison') {
      // Stack all 4 voices with analog detune
      const detunes = [-12, -4, 4, 12]; // Cents
      for (let i = 0; i < this.maxVoices; i++) {
        const v = this.voices[i];
        const detunedFreq = baseFreq * Math.pow(2, detunes[i] / 1200);
        v.triggerOn(midiNote, detunedFreq, velocity * 0.45, baseFreq, this.params.portamento);
      }
      this.activeVoiceMap.set(midiNote, this.voices);
    } 
    else if (mode === 'chord') {
      // S-1 Chord Memory Mode
      const intervals = this.getChordIntervals(this.params.chordType);
      for (let i = 0; i < Math.min(intervals.length, this.maxVoices); i++) {
        const v = this.voices[i];
        const chordMidi = midiNote + intervals[i];
        const chordFreq = this.midiToFreq(chordMidi);
        v.triggerOn(chordMidi, chordFreq, velocity * 0.5, chordFreq, 0);
      }
      this.activeVoiceMap.set(midiNote, this.voices);
    } 
    else {
      // Standard Polyphonic Allocation (Voice Stealing / Round Robin)
      let voice = this.voices.find(v => !v.isPlaying);
      if (!voice) {
        // Steal oldest playing voice
        voice = this.voices.reduce((oldest, current) => 
          current.lastTriggerTime < oldest.lastTriggerTime ? current : oldest
        );
      }
      voice.triggerOn(midiNote, baseFreq, velocity, baseFreq, 0);
      this.activeVoiceMap.set(midiNote, voice);
    }

    if (this.onNoteTrigger) {
      this.onNoteTrigger(midiNote, true);
    }
  }

  triggerNoteOff(midiNote) {
    if (!this.isInitialized) return;
    const entry = this.activeVoiceMap.get(midiNote);
    if (!entry) return;

    if (Array.isArray(entry)) {
      entry.forEach(v => v.triggerOff());
    } else {
      entry.triggerOff();
    }
    this.activeVoiceMap.delete(midiNote);

    if (this.onNoteTrigger) {
      this.onNoteTrigger(midiNote, false);
    }
  }

  allNotesOff() {
    this.voices.forEach(v => v.triggerOff(true));
    this.activeVoiceMap.clear();
  }

  getChordIntervals(type) {
    switch (type) {
      case 'maj': return [0, 4, 7, 12];
      case 'min': return [0, 3, 7, 12];
      case 'maj7': return [0, 4, 7, 11];
      case 'min7': return [0, 3, 7, 10];
      case 'sus4': return [0, 5, 7, 12];
      default: return [0, 3, 7, 10];
    }
  }

  // =========================================================================
  // AUDIO RECORDING & WAV EXPORT
  // =========================================================================
  startRecording() {
    if (!this.recDestination) return false;
    this.recordedChunks = [];
    try {
      this.recorder = new MediaRecorder(this.recDestination.stream, { mimeType: 'audio/webm' });
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.recorder.start(100);
      this.isRecording = true;
      return true;
    } catch (e) {
      console.error('Recording initialization error:', e);
      return false;
    }
  }

  stopRecording() {
    if (!this.recorder || !this.isRecording) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        this.isRecording = false;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}

// ===========================================================================
// S-1 SINGLE SYNTH VOICE ARCHITECTURE (ANALOG CIRCUIT BEHAVIOR)
// ===========================================================================
class S1Voice {
  constructor(engine, index) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.index = index;

    this.isPlaying = false;
    this.currentNote = null;
    this.lastTriggerTime = 0;

    this.setupNodes();
  }

  setupNodes() {
    const ctx = this.ctx;

    // Main Voice Gain
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;

    // 1. Saw Oscillator
    this.oscSaw = ctx.createOscillator();
    this.oscSaw.type = 'sawtooth';
    this.gainSaw = ctx.createGain();
    this.gainSaw.gain.value = this.engine.params.oscSaw;
    this.oscSaw.connect(this.gainSaw);

    // 2. Pulse Oscillator with PWM Modeling
    this.oscPulse = ctx.createOscillator();
    this.oscPulse.type = 'square';
    this.gainPulse = ctx.createGain();
    this.gainPulse.gain.value = this.engine.params.oscSquare;
    this.oscPulse.connect(this.gainPulse);

    // 3. Sub Oscillator (-1 oct / -2 oct / pulse)
    this.oscSub = ctx.createOscillator();
    this.oscSub.type = 'square';
    this.gainSub = ctx.createGain();
    this.gainSub.gain.value = this.engine.params.oscSub;
    this.oscSub.connect(this.gainSub);

    // 4. White Noise Generator
    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = this.engine.noiseBuffer;
    this.noiseSource.loop = true;
    this.gainNoise = ctx.createGain();
    this.gainNoise.gain.value = this.engine.params.oscNoise;
    this.noiseSource.connect(this.gainNoise);

    // 5. OSC DRAW Custom Periodic Wave Oscillator
    this.oscDraw = ctx.createOscillator();
    if (this.engine.customPeriodicWave) {
      this.oscDraw.setPeriodicWave(this.engine.customPeriodicWave);
    }
    this.gainDraw = ctx.createGain();
    this.gainDraw.gain.value = this.engine.params.oscDrawMix;
    this.oscDraw.connect(this.gainDraw);

    // 6. OSC CHOP Comb / Harmonic Slicer
    this.chopDelay = ctx.createDelay(0.05);
    this.chopDelay.delayTime.value = 0.002;
    this.chopFeedback = ctx.createGain();
    this.chopFeedback.gain.value = this.engine.params.oscChopComb;
    this.chopDelay.connect(this.chopFeedback);
    this.chopFeedback.connect(this.chopDelay);

    this.chopWetGain = ctx.createGain();
    this.chopWetGain.gain.value = this.engine.params.oscChop;
    this.chopDelay.connect(this.chopWetGain);

    // Oscillator Mixer Bus
    this.oscMixer = ctx.createGain();
    this.gainSaw.connect(this.oscMixer);
    this.gainPulse.connect(this.oscMixer);
    this.gainSub.connect(this.oscMixer);
    this.gainNoise.connect(this.oscMixer);
    this.gainDraw.connect(this.oscMixer);

    // Route dry mix + CHOP comb circuit
    this.oscMixer.connect(this.chopDelay);

    // 7. Filter Architecture (High-Pass + Cascaded 24dB Resonant Low-Pass)
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = this.engine.params.filterHpf;

    this.lpf1 = ctx.createBiquadFilter();
    this.lpf1.type = 'lowpass';
    this.lpf1.frequency.value = this.engine.params.filterCutoff;
    this.lpf1.Q.value = this.engine.params.filterResonance;

    this.lpf2 = ctx.createBiquadFilter();
    this.lpf2.type = 'lowpass';
    this.lpf2.frequency.value = this.engine.params.filterCutoff;
    this.lpf2.Q.value = this.engine.params.filterResonance * 0.5;

    // 8. LFO Modulation Matrix
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = this.engine.params.lfoRate;
    this.setLfoWave(this.engine.params.lfoWave);

    this.lfoPitchGain = ctx.createGain();
    this.lfoPitchGain.gain.value = this.engine.params.lfoPitchDepth * 200; // Cents
    this.lfo.connect(this.lfoPitchGain);
    this.lfoPitchGain.connect(this.oscSaw.detune);
    this.lfoPitchGain.connect(this.oscPulse.detune);
    this.lfoPitchGain.connect(this.oscDraw.detune);

    this.lfoFilterGain = ctx.createGain();
    this.lfoFilterGain.gain.value = this.engine.params.lfoFilterDepth * 3000;
    this.lfo.connect(this.lfoFilterGain);
    this.lfoFilterGain.connect(this.lpf1.frequency);
    this.lfoFilterGain.connect(this.lpf2.frequency);

    // Signal Routing: Mixer & Chop -> HPF -> LPF1 -> LPF2 -> VoiceGain -> Master VoiceBus
    this.oscMixer.connect(this.hpf);
    this.chopWetGain.connect(this.hpf);
    this.hpf.connect(this.lpf1);
    this.lpf1.connect(this.lpf2);
    this.lpf2.connect(this.voiceGain);
    this.voiceGain.connect(this.engine.voiceBus);

    // Start running continuous sound sources
    this.oscSaw.start();
    this.oscPulse.start();
    this.oscSub.start();
    this.noiseSource.start();
    this.oscDraw.start();
    this.lfo.start();
  }

  setLfoWave(shape) {
    if (shape === 'triangle') this.lfo.type = 'triangle';
    else if (shape === 'saw') this.lfo.type = 'sawtooth';
    else if (shape === 'square') this.lfo.type = 'square';
    else if (shape === 'sh') this.lfo.type = 'square'; // Stepped S&H approximation
  }

  updatePeriodicWave(pWave) {
    if (pWave && this.oscDraw) {
      this.oscDraw.setPeriodicWave(pWave);
    }
  }

  updateParam(name, value) {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    switch (name) {
      case 'oscSaw':
        this.gainSaw.gain.setTargetAtTime(value, now, 0.01);
        break;
      case 'oscSquare':
        this.gainPulse.gain.setTargetAtTime(value, now, 0.01);
        break;
      case 'oscSub':
        this.gainSub.gain.setTargetAtTime(value, now, 0.01);
        break;
      case 'subMode':
        this.updateSubFrequency(this.currentFreq || 440);
        break;
      case 'oscNoise':
        this.gainNoise.gain.setTargetAtTime(value, now, 0.01);
        break;
      case 'oscDrawMix':
        this.gainDraw.gain.setTargetAtTime(value, now, 0.01);
        break;
      case 'oscChop':
        this.chopWetGain.gain.setTargetAtTime(value, now, 0.01);
        break;
      case 'oscChopComb':
        this.chopFeedback.gain.setTargetAtTime(Math.min(value, 0.85), now, 0.01);
        break;
      case 'filterCutoff':
        this.lpf1.frequency.setTargetAtTime(value, now, 0.02);
        this.lpf2.frequency.setTargetAtTime(value, now, 0.02);
        break;
      case 'filterResonance':
        this.lpf1.Q.setTargetAtTime(value, now, 0.02);
        this.lpf2.Q.setTargetAtTime(value * 0.5, now, 0.02);
        break;
      case 'filterHpf':
        this.hpf.frequency.setTargetAtTime(value, now, 0.02);
        break;
      case 'lfoRate':
        this.lfo.frequency.setTargetAtTime(value, now, 0.02);
        break;
      case 'lfoWave':
        this.setLfoWave(value);
        break;
      case 'lfoPitchDepth':
        this.lfoPitchGain.gain.setTargetAtTime(value * 200, now, 0.02);
        break;
      case 'lfoFilterDepth':
        this.lfoFilterGain.gain.setTargetAtTime(value * 3000, now, 0.02);
        break;
    }
  }

  updateSubFrequency(freq) {
    const now = this.ctx.currentTime;
    const mode = this.engine.params.subMode;
    let subFreq = freq * 0.5; // -1 octave default
    if (mode === 'sub2') subFreq = freq * 0.25; // -2 octaves
    this.oscSub.frequency.setValueAtTime(subFreq, now);
  }

  triggerOn(midiNote, freq, velocity = 1.0, prevFreq = freq, glideTime = 0) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = this.engine.params;

    this.isPlaying = true;
    this.currentNote = midiNote;
    this.currentFreq = freq;
    this.lastTriggerTime = performance.now();

    // 1. Pitch glide & setting
    if (glideTime > 0.005) {
      this.oscSaw.frequency.setValueAtTime(prevFreq, now);
      this.oscPulse.frequency.setValueAtTime(prevFreq, now);
      this.oscDraw.frequency.setValueAtTime(prevFreq, now);

      this.oscSaw.frequency.exponentialRampToValueAtTime(freq, now + glideTime);
      this.oscPulse.frequency.exponentialRampToValueAtTime(freq, now + glideTime);
      this.oscDraw.frequency.exponentialRampToValueAtTime(freq, now + glideTime);
    } else {
      this.oscSaw.frequency.setValueAtTime(freq, now);
      this.oscPulse.frequency.setValueAtTime(freq, now);
      this.oscDraw.frequency.setValueAtTime(freq, now);
    }

    // Sub oscillator frequency based on subMode
    this.updateSubFrequency(freq);

    // S-1 CHOP Delay time tuned to fundamental harmonic
    const chopDelayT = Math.max(0.0005, 1 / (freq * (1 + p.oscPwm * 4)));
    this.chopDelay.delayTime.setValueAtTime(chopDelayT, now);

    // 2. Filter Key Tracking & Base Cutoff
    const keyFollowOffset = (midiNote - 60) * 40 * p.filterKeyFollow;
    const targetCutoff = Math.max(20, Math.min(20000, p.filterCutoff + keyFollowOffset));

    // 3. Filter Envelope (Snappy ADSR)
    const envPeakCutoff = Math.max(20, Math.min(20000, targetCutoff + (p.filterEnvDepth * 8000)));
    const envSustainCutoff = Math.max(20, Math.min(20000, targetCutoff + (p.filterEnvDepth * 8000 * p.envSustain)));

    this.lpf1.frequency.cancelScheduledValues(now);
    this.lpf2.frequency.cancelScheduledValues(now);
    this.lpf1.frequency.setValueAtTime(targetCutoff, now);
    this.lpf2.frequency.setValueAtTime(targetCutoff, now);

    // Attack -> Decay -> Sustain
    const attackEnd = now + Math.max(0.002, p.envAttack);
    const decayEnd = attackEnd + Math.max(0.005, p.envDecay);

    this.lpf1.frequency.linearRampToValueAtTime(envPeakCutoff, attackEnd);
    this.lpf2.frequency.linearRampToValueAtTime(envPeakCutoff, attackEnd);
    this.lpf1.frequency.exponentialRampToValueAtTime(Math.max(20, envSustainCutoff), decayEnd);
    this.lpf2.frequency.exponentialRampToValueAtTime(Math.max(20, envSustainCutoff), decayEnd);

    // 4. Amplitude Envelope (ADSR)
    this.voiceGain.gain.cancelScheduledValues(now);
    this.voiceGain.gain.setValueAtTime(this.voiceGain.gain.value, now);

    // Punchy Attack
    const targetVol = velocity * 0.75;
    this.voiceGain.gain.linearRampToValueAtTime(targetVol, attackEnd);
    // Decay to Sustain
    this.voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, targetVol * p.envSustain), decayEnd);
  }

  triggerOff(instant = false) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = this.engine.params;

    this.isPlaying = false;
    this.currentNote = null;

    this.voiceGain.gain.cancelScheduledValues(now);
    this.lpf1.frequency.cancelScheduledValues(now);
    this.lpf2.frequency.cancelScheduledValues(now);

    if (instant) {
      this.voiceGain.gain.setValueAtTime(0, now);
      return;
    }

    const relTime = Math.max(0.008, p.envRelease);
    this.voiceGain.gain.setValueAtTime(this.voiceGain.gain.value, now);
    this.voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + relTime);
    this.voiceGain.gain.setValueAtTime(0, now + relTime + 0.01);
  }
}

window.S1AudioEngine = S1AudioEngine;
