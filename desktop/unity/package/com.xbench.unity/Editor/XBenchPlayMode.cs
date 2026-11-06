using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
#if XBENCH_PIPELINE
using Unity.Pipeline.Commands;
#endif
#if XBENCH_SYPHON
using Klak.Syphon;
#endif

namespace XBench.Unity
{
    // Each play session gets what X Bench's Unity tab needs: the Game view as the Syphon server the tab draws,
    // and a game that keeps running while the Editor sits behind X Bench.
    [InitializeOnLoad]
    static class XBenchPlayMode
    {
        const int TickMs = 8;
        // Pipeline's own auto-tick setting before play, put back after it.
        static object[] _tickBefore;

        static XBenchPlayMode()
        {
            EditorApplication.playModeStateChanged += Changed;
        }

        static void Changed(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.ExitingPlayMode) Tick(false);
            if (change != PlayModeStateChange.EnteredPlayMode) return;
            Application.runInBackground = true;
            Tick(true);
            Publish();
#if XBENCH_PIPELINE
            XBenchTouch.Prepare();
#endif
        }

        // The Editor stops updating while another app has focus. The Pipeline package's set_autotick keeps it
        // going; during play it ticks at TickMs without persisting, and afterwards Pipeline's own setting returns.
        // Its class is internal, so the command is found by its name and its state read from its fields.
        static void Tick(bool play)
        {
#if XBENCH_PIPELINE
            var method = TypeCache.GetMethodsWithAttribute<CliCommandAttribute>()
                .FirstOrDefault(candidate => candidate.GetCustomAttribute<CliCommandAttribute>().Name == "set_autotick");
            if (method != null)
            {
                if (play)
                {
                    const BindingFlags field = BindingFlags.NonPublic | BindingFlags.Static;
                    var enabled = method.DeclaringType.GetField("s_Enabled", field)?.GetValue(null);
                    var interval = method.DeclaringType.GetField("s_IntervalMs", field)?.GetValue(null);
                    _tickBefore = enabled is bool on && interval is long ms ? new object[] { on, (int)ms, false } : null;
                    method.Invoke(null, new object[] { true, TickMs, false });
                }
                else if (_tickBefore != null)
                {
                    method.Invoke(null, _tickBefore);
                    _tickBefore = null;
                }
                return;
            }
#endif
            if (play) Debug.LogWarning("X Bench: the Pipeline package has no set_autotick, so the game pauses while Unity is in the background.");
        }

        static void Publish()
        {
#if XBENCH_SYPHON
            // Hidden, and gone again when play mode ends, like every object made during play.
            // Named after the project, so with several Editors open X Bench shows the one it sends input to.
            var name = "X Bench Game View: " + Directory.GetParent(Application.dataPath).FullName;
            var host = new GameObject(name) { hideFlags = HideFlags.HideInHierarchy | HideFlags.NotEditable };
            Object.DontDestroyOnLoad(host);
            var server = host.AddComponent<SyphonServer>();
            server.Resources = AssetDatabase.LoadAssetAtPath<SyphonResources>("Packages/jp.keijiro.klak.syphon/Internal/SyphonResources.asset");
            server.CaptureMethod = CaptureMethod.GameView;
            server.ServerName = name;
#else
            Debug.LogWarning("X Bench: KlakSyphon (jp.keijiro.klak.syphon) is missing, so the Unity tab shows nothing.");
#endif
        }
    }
}
