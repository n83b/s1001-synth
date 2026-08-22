/**
 * Roland AIRA Compact S-1 Tweak Synth - Application Bootstrap & Keyboard Handlers
 */

document.addEventListener('DOMContentLoaded', () => {
  const audioEngine = new S1AudioEngine();
  const sequencer = new S1Sequencer(audioEngine);
  const uiController = new S1UIController(audioEngine, sequencer);

  // Key map for computer QWERTY keyboard playing
  const KEY_NOTE_MAP = {
    'z': 0,  // C
    's': 1,  // C#
    'x': 2,  // D
    'd': 3,  // D#
    'c': 4,  // E
    'v': 5,  // F
    'g': 6,  // F#
    'b': 7,  // G
    'h': 8,  // G#
    'n': 9,  // A
    'j': 10, // A#
    'm': 11, // B
    ',': 12, // C5
    'l': 13, // C#5
    '.': 14, // D5
    ';': 15  // D#5
  };

  const activeComputerKeys = new Map();

  // Bulletproof Safari & Chrome gesture unlock
  const unlockEvents = ['click', 'touchstart', 'touchend', 'pointerdown', 'keydown'];
  const unlockAudio = () => {
    audioEngine.ensureAudioContext();
  };
  unlockEvents.forEach(evt => {
    window.addEventListener(evt, unlockAudio, { passive: true });
  });

  window.addEventListener('keydown', (e) => {
    audioEngine.ensureAudioContext();

    // Prevent default scrolling for Spacebar
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      sequencer.togglePlay();
      return;
    }

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
      return;
    }

    const key = e.key.toLowerCase();
    if (KEY_NOTE_MAP[key] !== undefined && !activeComputerKeys.has(key)) {
      const noteOffset = KEY_NOTE_MAP[key];
      const midiNote = 60 + (uiController.currentOctave * 12) + noteOffset;

      audioEngine.triggerNoteOn(midiNote, 0.9);
      activeComputerKeys.set(key, midiNote);

      const stepKey = document.querySelector(`.step-key[data-step="${noteOffset}"]`);
      if (stepKey) stepKey.classList.add('key-pressed');
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (activeComputerKeys.has(key)) {
      const midiNote = activeComputerKeys.get(key);
      audioEngine.triggerNoteOff(midiNote);
      activeComputerKeys.delete(key);

      const noteOffset = KEY_NOTE_MAP[key];
      const stepKey = document.querySelector(`.step-key[data-step="${noteOffset}"]`);
      if (stepKey) stepKey.classList.remove('key-pressed');
    }
  });

  console.log('Roland AIRA Compact S-1 Synth ready!');
});
