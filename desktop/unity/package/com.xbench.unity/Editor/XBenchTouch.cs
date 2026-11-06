#if XBENCH_PIPELINE
using Unity.Pipeline.Commands;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using TouchPhase = UnityEngine.InputSystem.TouchPhase;

namespace XBench.Unity
{
    // X Bench's fingers on the Game view: a virtual touchscreen of its own, so the real mouse cannot overwrite
    // a touch, and the game reads it the way it reads a phone's screen.
    static class XBenchTouch
    {
        static Touchscreen _screen;

        // Runs as each play session starts, since the first touch on a screen made for it gets lost, and the
        // Input System puts its settings back when play mode ends.
        public static void Prepare()
        {
            // The Editor sits behind X Bench while the game is played there, so input must not wait for focus.
            // A copy, since the project's settings asset would keep the change and ship it in builds.
            var settings = Object.Instantiate(InputSystem.settings);
            settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            InputSystem.settings = settings;
            if (_screen == null || !_screen.added) _screen = InputSystem.AddDevice<Touchscreen>("X Bench Touchscreen");
        }

        [CliCommand("xbench_touch", "Touch the Game view with a finger of X Bench's virtual touchscreen.",
            MainThreadRequired = true, Tags = new[] { "runtime/input" })]
        public static string Touch(
            [CliArg("x", "Screen X in pixels (origin bottom-left)", Required = true)] float x,
            [CliArg("y", "Screen Y in pixels (origin bottom-left)", Required = true)] float y,
            [CliArg("action", "down | move | up")] string action = "down",
            [CliArg("finger", "Finger number, from 0")] int finger = 0)
        {
            if (!Application.isPlaying) return "Not in play mode.";
            var phase = action == "up" ? TouchPhase.Ended : action == "move" ? TouchPhase.Moved : TouchPhase.Began;
            if (_screen == null || !_screen.added) Prepare();
            InputSystem.QueueStateEvent(_screen, new TouchState { touchId = finger + 1, phase = phase, position = new Vector2(x, y) });
            return $"{phase} at ({x:0},{y:0})";
        }
    }
}
#endif
