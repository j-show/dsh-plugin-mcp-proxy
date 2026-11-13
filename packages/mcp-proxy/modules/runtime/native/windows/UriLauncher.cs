using System;
using System.Reflection;
using System.Diagnostics;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Runtime.InteropServices;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using System.Threading;
using System.Text.RegularExpressions;
using Microsoft.Win32;

[assembly: AssemblyTitle("mcp-proxy")]
[assembly: AssemblyDescription("Local MCP connectivity")]

internal static class UriLauncher
{
    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint length);

    private static string LauncherPath(string filename)
    {
        StringBuilder path = new StringBuilder(32768);
        uint length = GetLongPathName(filename, path, (uint)path.Capacity);
        if (length == 0 || length >= path.Capacity) throw new IOException("Launcher path unavailable");
        return path.ToString();
    }

    private static void Trace(string stage)
    {
        try
        {
            string directory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            if (!String.Equals(Path.GetFileName(directory), "mcp-proxy-os", StringComparison.OrdinalIgnoreCase)) return;
            string filename = Path.Combine(directory, Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location) + ".activation.log");
            if (File.Exists(filename) && ((File.GetAttributes(filename) & FileAttributes.ReparsePoint) != 0
                || new FileInfo(filename).Length >= 65536)) return;
            File.AppendAllText(filename, DateTime.UtcNow.ToString("o") + " " + stage + "\n");
        }
        catch (Exception error)
        {
            // Denied diagnostics must not block activation or expose URI contents.
            GC.KeepAlive(error);
        }
    }

    [DataContract]
    private sealed class LaunchSettings
    {
        [DataMember(Name = "node", IsRequired = true)] public string Node;
        [DataMember(Name = "associateArgs", IsRequired = true)] public string AssociateArgs;
        [DataMember(Name = "home", IsRequired = true)] public string Home;
        [DataMember(Name = "registryKey")] public string RegistryKey;
        [DataMember(Name = "owner")] public string Owner;
        [DataMember(Name = "previousLauncher")] public string PreviousLauncher;
        [DataMember(Name = "installTimeoutMs")] public int InstallTimeoutMs;
        [DataMember(Name = "electronRunAsNode")] public bool ElectronRunAsNode;
        [DataMember(Name = "desktop")] public bool Desktop;
        [DataMember(Name = "localAppData")] public string LocalAppData;
    }

    [DataContract]
    private sealed class ActivationRequest
    {
        [DataMember(Name = "kind")] public string Kind = "activate";
        [DataMember(Name = "uri")] public string Uri;
    }
    [DataContract]
    private sealed class ActivationReply
    {
        [DataMember(Name = "ok")] public bool Ok;
    }
    [DataContract]
    private sealed class ControlReply
    {
        [DataMember(Name = "ok")] public bool Ok;
        [DataMember(Name = "value")] public ActivationReply Value;
    }

    private static void Complete(Task task, Stopwatch clock, int timeoutMs)
    {
        long remaining = timeoutMs - clock.ElapsedMilliseconds;
        if (remaining <= 0 || !task.Wait((int)remaining)) throw new TimeoutException();
        task.GetAwaiter().GetResult();
    }

    private static byte[] Exchange(LaunchSettings settings, byte[] frame, int limit)
    {
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", "dsh-mcp-proxy", PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous))
        using (MemoryStream response = new MemoryStream())
        {
            Stopwatch clock = Stopwatch.StartNew();
            pipe.Connect(settings.InstallTimeoutMs);
            Complete(pipe.WriteAsync(frame, 0, frame.Length), clock, settings.InstallTimeoutMs);
            byte[] chunk = new byte[4096];
            for (;;)
            {
                Task<int> read = pipe.ReadAsync(chunk, 0, chunk.Length);
                Complete(read, clock, settings.InstallTimeoutMs);
                int length = read.Result;
                if (length == 0) throw new IOException("Control response ended");
                for (int index = 0; index < length; index++)
                {
                    if (response.Length >= limit) throw new IOException("Control response limit exceeded");
                    response.WriteByte(chunk[index]);
                    if (chunk[index] == 10) return response.ToArray();
                }
            }
        }
    }

    private static int? ForwardToReadyOwner(LaunchSettings settings, string uri)
    {
        if (settings.InstallTimeoutMs < 1) return 4;
        byte[] status;
        try { status = Exchange(settings, Encoding.UTF8.GetBytes("STATUS\n"), 128); }
        catch (TimeoutException) { Trace("control-unavailable"); return null; }
        catch (IOException) { Trace("control-unavailable"); return null; }
        catch (Exception error) { Trace("control-error-" + error.GetType().Name); return 4; }
        string state = Encoding.UTF8.GetString(status);
        if (Regex.IsMatch(state, "\\APID [1-9][0-9]{0,9} starting\\n\\z")) return null;
        if (!Regex.IsMatch(state, "\\APID [1-9][0-9]{0,9} ready\\n\\z")) return 4;
        try
        {
            using (MemoryStream body = new MemoryStream())
            {
                new DataContractJsonSerializer(typeof(ActivationRequest)).WriteObject(body, new ActivationRequest { Uri = uri });
                string frame = "MANAGE " + Encoding.UTF8.GetString(body.ToArray()) + "\n";
                byte[] reply = Exchange(settings, Encoding.UTF8.GetBytes(frame), 1048576);
                using (MemoryStream input = new MemoryStream(reply))
                {
                    ControlReply result = (ControlReply)new DataContractJsonSerializer(typeof(ControlReply)).ReadObject(input);
                    bool accepted = result != null && result.Ok && result.Value != null && result.Value.Ok;
                    Trace(accepted ? "activation-forwarded" : "activation-rejected");
                    return accepted ? 0 : 4;
                }
            }
        }
        catch (Exception error)
        {
            // A dispatched activation is never replayed through a second GUI process.
            Trace("activation-forward-error-" + error.GetType().Name);
            return 4;
        }
    }

    private static int Registration(LaunchSettings settings, bool remove)
    {
        if (String.IsNullOrEmpty(settings.RegistryKey) || !settings.RegistryKey.StartsWith("Software\\", StringComparison.OrdinalIgnoreCase)
            || settings.RegistryKey.Length < 10 || settings.Owner == null || !Regex.IsMatch(settings.Owner, "\\A[a-f0-9]{64}\\z")
            || settings.InstallTimeoutMs < 1) return 1;
        // Assembly.Location and receipt paths can use different 8.3 aliases on CI.
        // Expand only the trusted current/predecessor paths; keep registry command checks exact.
        string executable = LauncherPath(Assembly.GetExecutingAssembly().Location);
        string command = "\"" + executable + "\" \"%1\"";
        string previous = null;
        if (!String.IsNullOrEmpty(settings.PreviousLauncher))
        {
            if (!Regex.IsMatch(settings.PreviousLauncher, "\\Amcp-proxy-[a-f0-9]{12}\\.exe\\z")) return 1;
            // The predecessor may already be deleted when recovering an interrupted receipt update.
            previous = "\"" + Path.Combine(Path.GetDirectoryName(executable), settings.PreviousLauncher) + "\" \"%1\"";
        }
        using (Mutex mutex = new Mutex(false, "Global\\dsh-mcp-proxy-installer"))
        {
            bool locked = false;
            try
            {
                try { locked = mutex.WaitOne(settings.InstallTimeoutMs); }
                catch (AbandonedMutexException) { locked = true; }
                if (!locked) return 1;
                using (RegistryKey existing = Registry.CurrentUser.OpenSubKey(settings.RegistryKey))
                {
                    if (existing != null)
                    {
                        if ((existing.GetValue("McpProxyOwner") as string) != settings.Owner) return 2;
                        using (RegistryKey open = existing.OpenSubKey("shell\\open\\command"))
                        {
                            string current = open == null ? null : open.GetValue("") as string;
                            if (current != null && current != command && current != previous) return 2;
                        }
                    }
                    else if (remove) return 0;
                }
                if (remove)
                {
                    Registry.CurrentUser.DeleteSubKeyTree(settings.RegistryKey, false);
                    SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
                    return 0;
                }
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(settings.RegistryKey))
                {
                    key.SetValue("McpProxyOwner", settings.Owner, RegistryValueKind.String);
                    key.SetValue("", "URL:mcp-proxy", RegistryValueKind.String);
                    key.SetValue("URL Protocol", "", RegistryValueKind.String);
                    key.SetValue("FriendlyTypeName", "mcp-proxy", RegistryValueKind.String);
                    using (RegistryKey application = key.CreateSubKey("Application"))
                        application.SetValue("ApplicationName", "mcp-proxy", RegistryValueKind.String);
                    using (RegistryKey open = key.CreateSubKey("shell\\open\\command"))
                        open.SetValue("", command, RegistryValueKind.String);
                }
                SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
                return 0;
            }
            finally { if (locked) mutex.ReleaseMutex(); }
        }
    }

    private static bool IsAssociation(string value)
    {
        const string prefix = "mcp-proxy://associate/";
        if (value.Length > 4096 || !value.StartsWith(prefix, StringComparison.Ordinal)) { Trace("uri-prefix-invalid"); return false; }
        foreach (char c in value) if (c <= 32 || c == 127 || c == '"') return false;
        int query = value.IndexOf('?');
        string plain = query < 0 ? value : value.Substring(0, query);
        if (plain.Length != prefix.Length + 43) { Trace("uri-path-length-invalid"); return false; }
        foreach (char c in plain.Substring(prefix.Length))
        {
            if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c != '_' && c != '-') return false;
        }
        if (query < 0) return true;
        string[] parts = value.Substring(query + 1).Split('&');
        if (parts.Length != 2) { Trace("uri-query-count-invalid"); return false; }
        bool version = false, origin = false;
        foreach (string part in parts)
        {
            int split = part.IndexOf('=');
            if (split < 1) return false;
            string key = Uri.UnescapeDataString(part.Substring(0, split));
            string item = Uri.UnescapeDataString(part.Substring(split + 1));
            if (key == "v" && !version && item == "2") version = true;
            else if (key == "origin" && !origin)
            {
                Uri server;
                if (!Uri.TryCreate(item, UriKind.Absolute, out server) || server.Scheme != "https" || server.UserInfo != ""
                    || server.Query != "" || server.Fragment != "" || server.GetLeftPart(UriPartial.Authority) != item) {
                    Trace("uri-origin-invalid"); return false;
                }
                origin = true;
            }
            else return false;
        }
        return version && origin;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 1) { Trace("argument-count-invalid"); return 1; }
        bool register = args[0] == "--register";
        bool unregister = args[0] == "--unregister";
        if (!register && !unregister && !IsAssociation(args[0])) { Trace("activation-invalid"); return 1; }
        if (!register && !unregister) Trace("activation-received");
        try
        {
            string filename = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.json");
            // This fixed metadata format contains installation paths, never deployment credentials.
            if (new FileInfo(filename).Length > 262144) return 1;
            LaunchSettings settings;
            using (FileStream file = File.OpenRead(filename))
                settings = (LaunchSettings)new DataContractJsonSerializer(typeof(LaunchSettings)).ReadObject(file);
            if (register || unregister) return Registration(settings, unregister);
            Trace("metadata-loaded");
            if (settings.Desktop)
            {
                int? forwarded = ForwardToReadyOwner(settings, args[0]);
                if (forwarded.HasValue) return forwarded.Value;
            }
            if (!Path.IsPathRooted(settings.Node) || !File.Exists(settings.Node) || !Directory.Exists(settings.Home)) {
                Trace("target-unavailable"); return 1;
            }
            ProcessStartInfo start = new ProcessStartInfo(settings.Node, settings.AssociateArgs + " " + args[0]);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = settings.Desktop ? ProcessWindowStyle.Normal : ProcessWindowStyle.Hidden;
            start.WorkingDirectory = settings.Home;
            start.EnvironmentVariables["DSH_HOME"] = settings.Home;
            if (!String.IsNullOrEmpty(settings.LocalAppData)) {
                if (!Path.IsPathRooted(settings.LocalAppData)) throw new IOException("Invalid app-data context");
                start.EnvironmentVariables["LOCALAPPDATA"] = settings.LocalAppData;
            }
            start.EnvironmentVariables.Remove("CHROME_CRASHPAD_PIPE_NAME");
            start.EnvironmentVariables.Remove("CHROME_CRASHPAD_SERVER_URL");
            if (settings.Desktop)
            {
                start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                start.EnvironmentVariables["ELECTRON_LOG_FILE"] = Path.Combine(settings.Home, "mcp-proxy-electron.log");
                start.EnvironmentVariables["ELECTRON_ENABLE_LOGGING"] = "1";
            }
            else if (settings.ElectronRunAsNode) start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            start.RedirectStandardOutput = !settings.Desktop;
            start.RedirectStandardError = !settings.Desktop;
            using (Process child = Process.Start(start))
            {
                Trace("child-spawned");
                if (settings.Desktop) return child == null ? 1 : 0;
                Task output = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
                Task error = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.WaitForExit();
                Task.WaitAll(output, error);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            // URI and installation data never enter an error dialog or console.
            Trace("activation-error-" + error.GetType().Name + "-" + error.HResult.ToString("x8"));
            return 1;
        }
    }
}
