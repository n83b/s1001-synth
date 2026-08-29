/**
 * Barnestorm S-1001 Tweak Synth - Application Bootstrap & Keyboard Handlers
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

    const editModeShortcuts = {
      '1': 'note',
      '2': 'plock',
      '3': 'prob'
    };
    if (!e.repeat && editModeShortcuts[e.key]) {
      e.preventDefault();
      const modeButton = document.querySelector(`[data-step-edit-mode="${editModeShortcuts[e.key]}"]`);
      if (modeButton) modeButton.click();
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (sequencer.selectedStep !== null) {
        e.preventDefault();
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        uiController.moveSelectedStep(direction);
      }
      return;
    }

    if (e.key === '-' || e.key === '+') {
      e.preventDefault();
      const octaveButtonId = e.key === '-' ? 'btn-oct-down' : 'btn-oct-up';
      const octaveButton = document.getElementById(octaveButtonId);
      if (octaveButton) octaveButton.click();
      return;
    }

    const key = e.key.toLowerCase();
    if (KEY_NOTE_MAP[key] !== undefined && !activeComputerKeys.has(key)) {
      const noteOffset = KEY_NOTE_MAP[key];
      const midiNote = 60 + (uiController.currentOctave * 12) + noteOffset;

      const inputSource = `computer:${key}`;
      audioEngine.triggerNoteOn(midiNote, 0.9, null, inputSource);
      sequencer.addArpHeldNote(midiNote, inputSource);
      activeComputerKeys.set(key, midiNote);

      if (e.shiftKey) {
        uiController.toggleNoteForSelectedStep(midiNote);
      }

      const stepKey = document.querySelector(`.step-key[data-step="${noteOffset}"]`);
      if (stepKey) stepKey.classList.add('key-pressed');
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (activeComputerKeys.has(key)) {
      const midiNote = activeComputerKeys.get(key);
      const inputSource = `computer:${key}`;
      audioEngine.triggerNoteOff(midiNote, null, inputSource);
      sequencer.removeArpHeldNote(midiNote, inputSource);
      activeComputerKeys.delete(key);

      const noteOffset = KEY_NOTE_MAP[key];
      const stepKey = document.querySelector(`.step-key[data-step="${noteOffset}"]`);
      if (stepKey) stepKey.classList.remove('key-pressed');
    }
  });

  console.log('Barnestorm S-1001 Tweak Synth ready!');
});
