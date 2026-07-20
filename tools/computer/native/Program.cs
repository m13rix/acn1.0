using Microsoft.Win32;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Win32.UI.Accessibility;

namespace Telos.ComputerWorker;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    [MTAThread]
    private static int Main(string[] args)
    {
        // A detached Windows daemon intentionally has no console handles.
        // Named-pipe readers/writers below specify UTF-8 explicitly.

        var pipeName = ReadArg(args, "--pipe") ?? "telos-computer-uia-v1";
        var statePath = ReadArg(args, "--state");
        var mutexName = $"Local\\TelosComputerWorker-{ShortHash(pipeName)}";
        using var mutex = new Mutex(initiallyOwned: true, mutexName, out var ownsMutex);
        if (!ownsMutex)
        {
            return 0;
        }

        var engine = new ComputerEngine();
        WriteState(statePath);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => DeleteState(statePath);

        while (true)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.CurrentUserOnly);
                pipe.WaitForConnection();
                using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 64 * 1024, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
                {
                    AutoFlush = true,
                    NewLine = "\n",
                };

                var line = reader.ReadLine();
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                var started = Stopwatch.StartNew();
                object response;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    var id = root.TryGetProperty("id", out var idNode) ? idNode.GetString() : null;
                    var command = root.GetProperty("command").GetString() ?? throw new InvalidOperationException("Missing command.");
                    var result = engine.Execute(command, root);
                    response = new { id, ok = true, result, elapsedMs = started.ElapsedMilliseconds };
                }
                catch (Exception ex)
                {
                    response = new
                    {
                        ok = false,
                        error = FlattenException(ex),
                        elapsedMs = started.ElapsedMilliseconds,
                    };
                }

                writer.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            }
            catch
            {
                Thread.Sleep(50);
            }
        }
    }

    private static string? ReadArg(string[] args, string name)
    {
        for (var index = 0; index < args.Length - 1; index++)
        {
            if (string.Equals(args[index], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[index + 1];
            }
        }
        return null;
    }

    private static string FlattenException(Exception exception)
    {
        var messages = new List<string>();
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (!string.IsNullOrWhiteSpace(current.Message) && !messages.Contains(current.Message))
            {
                messages.Add(current.Message.Trim());
            }
        }
        return string.Join(" -> ", messages);
    }

    private static string ShortHash(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).Substring(0, 12);

    private static void WriteState(string? statePath)
    {
        if (string.IsNullOrWhiteSpace(statePath)) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
            File.WriteAllText(statePath, JsonSerializer.Serialize(new
            {
                pid = Environment.ProcessId,
                startedAt = DateTimeOffset.UtcNow,
                version = 1,
            }, JsonOptions));
        }
        catch { }
    }

    private static void DeleteState(string? statePath)
    {
        if (string.IsNullOrWhiteSpace(statePath)) return;
        try { File.Delete(statePath); } catch { }
    }
}

internal sealed class ComputerEngine
{
    private readonly IUIAutomation automation;
    private readonly WindowManager windows = new();
    private readonly AppResolver resolver;
    private readonly Dictionary<string, ElementEntry> elements = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, VisualEntry> visualElements = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<IntPtr, SnapshotState> previousSnapshots = new();
    private readonly Dictionary<int, IntPtr> preferredWindows = new();
    private readonly Dictionary<int, ElementEntry> lastInputEntries = new();
    private readonly InteractionLeaseManager leases;
    private int? lastActivePid;

    public ComputerEngine()
    {
        var automationType = Type.GetTypeFromCLSID(new Guid("E22AD333-B25F-460C-83D0-0581107395C9"), throwOnError: true)!;
        automation = (IUIAutomation)Activator.CreateInstance(automationType)!;
        resolver = new AppResolver(windows);
        leases = new InteractionLeaseManager(windows);
    }

    public object? Execute(string command, JsonElement request)
    {
        return command.ToLowerInvariant() switch
        {
            "ping" => new { pid = Environment.ProcessId, version = 1 },
            "windows" => ListWindows(request),
            "open" => Open(request),
            "focuswindow" => FocusWindow(request),
            "snapshot" => Snapshot(request, changesOnly: false),
            "changes" or "getchanges" => Snapshot(request, changesOnly: true),
            "click" => Click(request),
            "clickat" => ClickAt(request),
            "settext" => SetText(request),
            "key" => Key(request),
            "type" => TypeText(request),
            "scroll" => Scroll(request),
            "release" => Release(request),
            _ => throw new ArgumentException($"Unknown computer command: {command}"),
        };
    }

    private object ListWindows(JsonElement request)
    {
        var includeHidden = GetBool(request, "includeHidden", true);
        var includeUntitled = GetBool(request, "includeUntitled", false);
        var maxResults = Math.Clamp(GetInt(request, "maxResults", 250), 1, 2000);
        return windows.List(includeHidden, includeUntitled)
            .Take(maxResults)
            .Select(WindowDto.From)
            .ToArray();
    }

    private object Open(JsonElement request)
    {
        var waitTimeoutMs = Math.Clamp(GetInt(request, "waitTimeoutMs", 15_000), 250, 120_000);
        var leaseMs = Math.Clamp(GetInt(request, "keepVisibleMs", InteractionLeaseManager.DefaultLeaseMs), 1_000, 600_000);
        WindowInfo window;

        if (request.TryGetProperty("target", out var target) && target.ValueKind == JsonValueKind.Number)
        {
            var pid = target.GetInt32();
            window = windows.WaitForProcessWindow(pid, waitTimeoutMs)
                ?? throw new InvalidOperationException($"No top-level window was found for PID {pid}.");
        }
        else
        {
            var name = request.GetProperty("target").GetString();
            if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("App name must not be empty.");
            window = resolver.ResolveAndOpen(name.Trim(), waitTimeoutMs);
        }

        windows.EnsureVisible(window.Handle);
        preferredWindows[window.ProcessId] = window.Handle;
        lastActivePid = window.ProcessId;
        leases.Touch(window.ProcessId, window.Handle, leaseMs);
        return window.ProcessId;
    }

    private object FocusWindow(JsonElement request)
    {
        var window = ResolveWindow(request, requireExplicitHandle: true);
        var leaseMs = Math.Clamp(GetInt(request, "keepVisibleMs", InteractionLeaseManager.DefaultLeaseMs), 1_000, 600_000);
        windows.EnsureVisible(window.Handle);
        var activate = GetBool(request, "activate", false);
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        if (activate && !allowForeground)
            throw new InvalidOperationException("activate=true requires allowForegroundFallback=true because foreground activation can interrupt the user.");
        if (activate && !NativeInput.ActivateWindow(window.Handle))
            throw new InvalidOperationException($"Windows refused to activate '{window.Title}'.");
        preferredWindows[window.ProcessId] = window.Handle;
        lastActivePid = window.ProcessId;
        leases.Touch(window.ProcessId, window.Handle, leaseMs);
        return WindowDto.From(windows.FindByHandle(window.Handle) ?? window);
    }

    private object Snapshot(JsonElement request, bool changesOnly)
    {
        var window = ResolveWindow(request);
        var pid = window.ProcessId;
        var options = new SnapshotOptions(
            InteractiveOnly: GetBool(request, "interactiveOnly", false),
            VisibleOnly: GetBool(request, "visibleOnly", false),
            RawView: GetBool(request, "rawView", false),
            MaxDepth: Math.Clamp(GetInt(request, "maxDepth", 15), 0, 100),
            MaxElements: Math.Clamp(GetInt(request, "maxElements", 5000), 1, 50_000),
            VisualFallback: GetString(request, "visualFallback", "auto").ToLowerInvariant());
        if (options.VisualFallback is not ("auto" or "always" or "never"))
            throw new ArgumentException("visualFallback must be 'auto', 'always', or 'never'.");

        windows.EnsureVisible(window.Handle);
        leases.Touch(pid, window.Handle);

        var state = BuildSnapshot(window, options);
        var hadPrevious = previousSnapshots.TryGetValue(window.Handle, out var previous);
        previousSnapshots[window.Handle] = state;

        foreach (var oldId in elements.Where(pair => pair.Value.RootWindow == window.Handle).Select(pair => pair.Key).ToArray())
        {
            elements.Remove(oldId);
        }
        foreach (var entry in state.ElementEntries)
        {
            elements[entry.Id] = entry;
        }
        foreach (var oldId in visualElements.Where(pair => pair.Value.RootWindow == window.Handle).Select(pair => pair.Key).ToArray())
            visualElements.Remove(oldId);
        foreach (var entry in state.VisualEntries)
            visualElements[entry.Id] = entry;
        lastActivePid = pid;
        var focused = state.ElementEntries.FirstOrDefault(entry => entry.HasKeyboardFocus);
        if (focused is not null) lastInputEntries[pid] = focused;

        if (!changesOnly)
        {
            return state.Formatted;
        }
        if (!hadPrevious || previous is null)
        {
            return $"[no previous snapshot for window 0x{window.Handle.ToInt64():X}; returning the full tree]\n{state.Formatted}";
        }
        return FormatChanges(previous, state);
    }

    private object Click(JsonElement request)
    {
        var requestedId = request.TryGetProperty("elementId", out var idNode) ? idNode.GetString() : null;
        if (!string.IsNullOrWhiteSpace(requestedId) && visualElements.TryGetValue(requestedId, out var visual))
        {
            var allowVisualForeground = GetBool(request, "allowForegroundFallback", false);
            var forceVisualForeground = GetBool(request, "foreground", false);
            if (forceVisualForeground && !allowVisualForeground)
                throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
            windows.EnsureVisible(visual.RootWindow);
            leases.Touch(visual.ProcessId, visual.RootWindow);
            lastActivePid = visual.ProcessId;
            var point = new PointInt((int)Math.Round(visual.Bounds.X + visual.Bounds.Width / 2), (int)Math.Round(visual.Bounds.Y + visual.Bounds.Height / 2));
            if (forceVisualForeground)
            {
                if (NativeInput.ClickForegroundAt(visual.RootWindow, point, 1, out var forcedError))
                    return new ActionResult(true, visual.Id, visual.ProcessId, "ocr-SendInput-forced", false,
                        "Explicit foreground input briefly used and restored the system pointer. Verify the resulting state.");
                throw new InvalidOperationException($"Forced foreground click failed for OCR element {visual.Id}: {forcedError}");
            }
            if (NativeInput.ClickWindowMessage(visual.RootWindow, point, 1, out var visualError))
                return new ActionResult(true, visual.Id, visual.ProcessId, "ocr-window-message", true,
                    "Clicked the center of an OCR-derived text region without moving the shared pointer. Verify the resulting state.");
            var visualForegroundError = string.Empty;
            if (allowVisualForeground && NativeInput.ClickForegroundAt(visual.RootWindow, point, 1, out visualForegroundError))
                return new ActionResult(true, visual.Id, visual.ProcessId, "ocr-SendInput", false,
                    "Foreground fallback briefly moved and restored the system pointer.");
            throw new InvalidOperationException($"No click strategy succeeded for OCR element {visual.Id}. {visualError}. {visualForegroundError}");
        }
        var entry = GetElement(request);
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        var forceForeground = GetBool(request, "foreground", false);
        if (forceForeground && !allowForeground)
            throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
        leases.Touch(entry.ProcessId, entry.RootWindow);
        windows.EnsureVisible(entry.RootWindow);
        lastActivePid = entry.ProcessId;
        lastInputEntries[entry.ProcessId] = entry;

        if (forceForeground)
        {
            if (NativeInput.ClickForeground(entry, out var forcedError))
                return ActionResult.Ok(entry, "SendInput-forced", backgroundSafe: false,
                    warning: "Explicit foreground input briefly used and restored the system pointer. Verify the resulting state.");
            throw new InvalidOperationException($"Forced foreground click failed for {entry.Id}: {forcedError}");
        }

        if (TryInvoke(entry.Element, out var patternName))
        {
            return ActionResult.Ok(entry, patternName!, backgroundSafe: true);
        }

        if (NativeInput.ClickWindowMessage(entry, out var messageError))
        {
            return ActionResult.Ok(entry, "window-message", backgroundSafe: true,
                warning: "The message was delivered, but some GPU/Electron apps ignore synthetic window messages. Verify the resulting UI state with getChanges().");
        }

        var foregroundError = string.Empty;
        if (allowForeground && NativeInput.ClickForeground(entry, out foregroundError))
        {
            return ActionResult.Ok(entry, "SendInput", backgroundSafe: false,
                warning: "Foreground fallback briefly used the system pointer; it was restored afterward.");
        }

        var suffix = allowForeground ? $" Foreground fallback also failed: {foregroundError}" : " Pass { allowForegroundFallback: true } only if temporarily taking foreground input is acceptable.";
        throw new InvalidOperationException($"No background click strategy succeeded for {entry.Id}. {messageError}.{suffix}");
    }

    private object ClickAt(JsonElement request)
    {
        if (!request.TryGetProperty("x", out var xNode) || !xNode.TryGetInt32(out var x)
            || !request.TryGetProperty("y", out var yNode) || !yNode.TryGetInt32(out var y))
            throw new ArgumentException("clickAt requires integer x and y screen coordinates.");
        var clicks = Math.Clamp(GetInt(request, "clicks", 1), 1, 3);
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        var forceForeground = GetBool(request, "foreground", false);
        if (forceForeground && !allowForeground)
            throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
        var window = ResolveWindow(request);
        var pid = window.ProcessId;
        var point = new PointInt(x, y);
        if (!Contains(window.Rect, point))
            throw new ArgumentOutOfRangeException($"Point ({x}, {y}) is outside the managed window '{window.Title}' ({window.Rect.Left},{window.Rect.Top} {window.Rect.Width}x{window.Rect.Height}).");

        windows.EnsureVisible(window.Handle);
        leases.Touch(pid, window.Handle);
        lastActivePid = pid;
        if (forceForeground)
        {
            if (NativeInput.ClickForegroundAt(window.Handle, point, clicks, out var forcedError))
                return new ActionResult(true, $"point-{x}-{y}", pid, "SendInput-forced", false,
                    "Explicit foreground input briefly used and restored the system pointer. Verify the resulting state.");
            throw new InvalidOperationException($"Forced foreground coordinate click failed at ({x}, {y}): {forcedError}");
        }
        if (NativeInput.ClickWindowMessage(window.Handle, point, clicks, out var messageError))
        {
            return new ActionResult(true, $"point-{x}-{y}", pid, clicks == 1 ? "window-message-coordinate" : $"window-message-coordinate-x{clicks}", true,
                "Mouse messages were delivered at the requested screen coordinate without moving the shared pointer. Verify the resulting UI state with snapshot().");
        }

        var foregroundError = string.Empty;
        if (allowForeground && NativeInput.ClickForegroundAt(window.Handle, point, clicks, out foregroundError))
        {
            return new ActionResult(true, $"point-{x}-{y}", pid, "SendInput", false,
                "Foreground fallback briefly moved and restored the system pointer. It was not used unless explicitly requested.");
        }

        var suffix = allowForeground ? $" Foreground fallback also failed: {foregroundError}" : " Pass { allowForegroundFallback: true } only if temporarily taking foreground pointer input is acceptable.";
        throw new InvalidOperationException($"No background coordinate click strategy succeeded at ({x}, {y}). {messageError}.{suffix}");
    }

    private object SetText(JsonElement request)
    {
        var requestedId = request.TryGetProperty("elementId", out var requestedNode) ? requestedNode.GetString() : null;
        if (!string.IsNullOrWhiteSpace(requestedId) && visualElements.TryGetValue(requestedId, out var visual))
        {
            var visualText = request.TryGetProperty("text", out var visualTextNode) ? visualTextNode.GetString() ?? string.Empty : string.Empty;
            var allowVisualForeground = GetBool(request, "allowForegroundFallback", false);
            var forceVisualForeground = GetBool(request, "foreground", false);
            if (forceVisualForeground && !allowVisualForeground)
                throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
            var point = new PointInt((int)Math.Round(visual.Bounds.X + visual.Bounds.Width / 2), (int)Math.Round(visual.Bounds.Y + visual.Bounds.Height / 2));
            windows.EnsureVisible(visual.RootWindow);
            leases.Touch(visual.ProcessId, visual.RootWindow);
            lastActivePid = visual.ProcessId;
            if (forceVisualForeground)
            {
                var forcedError = string.Empty;
                if (NativeInput.ClickForegroundAt(visual.RootWindow, point, 1, out _)
                    && NativeInput.TypeForeground(visual.RootWindow, visualText, replace: true, out forcedError))
                    return new ActionResult(true, visual.Id, visual.ProcessId, "ocr-click+SendInput-forced", false,
                        "Explicit foreground input briefly used system pointer and keyboard input. Verify the field value.");
                throw new InvalidOperationException($"Forced foreground text entry failed for OCR element {visual.Id}: {forcedError}");
            }
            var visualError = string.Empty;
            if (NativeInput.ClickWindowMessage(visual.RootWindow, point, 1, out _)
                && NativeInput.TypeWindowMessage(visual.RootWindow, null, visualText, replace: true, out visualError))
                return new ActionResult(true, visual.Id, visual.ProcessId, "ocr-click+window-message-text", true,
                    "Clicked the OCR-derived region and delivered replacement text without using the shared keyboard. Verify the field value.");
            var visualForegroundError = string.Empty;
            if (allowVisualForeground && NativeInput.ClickForegroundAt(visual.RootWindow, point, 1, out _)
                && NativeInput.TypeForeground(visual.RootWindow, visualText, replace: true, out visualForegroundError))
                return new ActionResult(true, visual.Id, visual.ProcessId, "ocr-click+SendInput", false,
                    "Foreground fallback briefly used system pointer and keyboard input.");
            throw new InvalidOperationException($"No text-entry strategy succeeded for OCR element {visual.Id}. {visualError}. {visualForegroundError}");
        }
        var entry = GetElement(request);
        var text = request.TryGetProperty("text", out var textNode) ? textNode.GetString() ?? string.Empty : string.Empty;
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        var forceForeground = GetBool(request, "foreground", false);
        if (forceForeground && !allowForeground)
            throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
        leases.Touch(entry.ProcessId, entry.RootWindow);
        windows.EnsureVisible(entry.RootWindow);
        lastActivePid = entry.ProcessId;
        lastInputEntries[entry.ProcessId] = entry;

        if (forceForeground)
        {
            if (NativeInput.SetTextForeground(entry, text, out var forcedError))
                return ActionResult.Ok(entry, "SendInput-forced", backgroundSafe: false,
                    warning: "Explicit foreground input briefly used the system keyboard. Verify the field value.");
            throw new InvalidOperationException($"Forced foreground text entry failed for {entry.Id}: {forcedError}");
        }

        if (TrySetValue(entry.Element, text, out var patternName))
        {
            return ActionResult.Ok(entry, patternName!, backgroundSafe: true);
        }

        if (NativeInput.SetTextWindowMessage(entry, text, out var messageError))
        {
            return ActionResult.Ok(entry, "window-message-text", backgroundSafe: true,
                warning: "Text messages were delivered, but some GPU/Electron apps require real foreground keyboard input. Verify the field value with getChanges().");
        }

        var foregroundError = string.Empty;
        if (allowForeground && NativeInput.SetTextForeground(entry, text, out foregroundError))
        {
            return ActionResult.Ok(entry, "SendInput", backgroundSafe: false,
                warning: "Foreground fallback briefly used the system keyboard focus.");
        }

        var suffix = allowForeground ? $" Foreground fallback also failed: {foregroundError}" : " Pass { allowForegroundFallback: true } only if temporarily taking keyboard focus is acceptable.";
        throw new InvalidOperationException($"No background text strategy succeeded for {entry.Id}. {messageError}.{suffix}");
    }

    private object Key(JsonElement request)
    {
        var keys = request.TryGetProperty("keys", out var keysNode) ? keysNode.GetString() : null;
        if (string.IsNullOrWhiteSpace(keys)) throw new ArgumentException("keys must be a non-empty key name or chord such as 'Enter' or 'Ctrl+Z'.");
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        var forceForeground = GetBool(request, "foreground", false);
        if (forceForeground && !allowForeground)
            throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
        ElementEntry? entry = null;
        if (request.TryGetProperty("elementId", out var elementNode) && elementNode.ValueKind == JsonValueKind.String)
            entry = GetElement(request);

        var window = entry is null ? ResolveWindow(request) : null;
        var pid = entry?.ProcessId ?? window!.ProcessId;
        var rootWindow = entry?.RootWindow ?? window?.Handle
            ?? throw new InvalidOperationException($"No top-level window was found for PID {pid}.");
        var target = entry ?? (lastInputEntries.TryGetValue(pid, out var remembered) && remembered.RootWindow == rootWindow ? remembered : null);

        windows.EnsureVisible(rootWindow);
        leases.Touch(pid, rootWindow);
        lastActivePid = pid;
        if (forceForeground)
        {
            if (NativeInput.KeyForeground(rootWindow, keys, out var forcedError))
                return new ActionResult(true, target?.Id ?? $"window-0x{rootWindow.ToInt64():X}", pid, "SendInput-forced", false,
                    "Explicit foreground input briefly used the system keyboard. Verify the resulting state.");
            throw new InvalidOperationException($"Forced foreground key input failed for '{keys}': {forcedError}");
        }
        if (NativeInput.KeyWindowMessage(rootWindow, target?.Bounds, keys, out var keyError))
        {
            return new ActionResult(true, target?.Id ?? $"pid-{pid}", pid, "window-message-key", true,
                "Key messages were delivered to the managed app without using the shared keyboard. Verify the resulting UI state with getChanges() or snapshot().");
        }

        var foregroundError = string.Empty;
        if (allowForeground && NativeInput.KeyForeground(rootWindow, keys, out foregroundError))
        {
            return new ActionResult(true, target?.Id ?? $"pid-{pid}", pid, "SendInput", false,
                "Foreground fallback briefly used the system keyboard. It was not used unless explicitly requested.");
        }

        var suffix = allowForeground ? $" Foreground fallback also failed: {foregroundError}" : " Pass { allowForegroundFallback: true } only if temporarily taking foreground keyboard input is acceptable.";
        throw new InvalidOperationException($"No background key strategy succeeded for '{keys}'. {keyError}.{suffix}");
    }

    private object TypeText(JsonElement request)
    {
        var text = request.TryGetProperty("text", out var textNode) ? textNode.GetString() ?? string.Empty : string.Empty;
        var replace = GetBool(request, "replace", true);
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        var forceForeground = GetBool(request, "foreground", false);
        if (forceForeground && !allowForeground)
            throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
        ElementEntry? entry = null;
        if (request.TryGetProperty("elementId", out var elementNode) && elementNode.ValueKind == JsonValueKind.String)
            entry = GetElement(request);

        var window = entry is null ? ResolveWindow(request) : null;
        var pid = entry?.ProcessId ?? window!.ProcessId;
        var rootWindow = entry?.RootWindow ?? window!.Handle;
        var target = entry ?? (lastInputEntries.TryGetValue(pid, out var remembered) && remembered.RootWindow == rootWindow ? remembered : null);

        windows.EnsureVisible(rootWindow);
        leases.Touch(pid, rootWindow);
        lastActivePid = pid;
        if (forceForeground)
        {
            if (NativeInput.TypeForeground(rootWindow, text, replace, out var forcedError))
                return new ActionResult(true, target?.Id ?? $"window-0x{rootWindow.ToInt64():X}", pid, "SendInput-forced", false,
                    "Explicit foreground input briefly used the system keyboard. Verify the resulting field value.");
            throw new InvalidOperationException($"Forced foreground typing failed: {forcedError}");
        }
        if (NativeInput.TypeWindowMessage(rootWindow, target?.Bounds, text, replace, out var messageError))
        {
            return new ActionResult(true, target?.Id ?? $"window-0x{rootWindow.ToInt64():X}", pid, "window-message-text", true,
                "Text messages were delivered to the exact managed window without using the shared keyboard. Verify the resulting field value.");
        }

        var foregroundError = string.Empty;
        if (allowForeground && NativeInput.TypeForeground(rootWindow, text, replace, out foregroundError))
        {
            return new ActionResult(true, target?.Id ?? $"window-0x{rootWindow.ToInt64():X}", pid, "SendInput", false,
                "Foreground fallback briefly used the system keyboard. It was not used unless explicitly requested.");
        }

        var suffix = allowForeground ? $" Foreground fallback also failed: {foregroundError}" : " Pass { allowForegroundFallback: true } only if temporarily taking foreground keyboard input is acceptable.";
        throw new InvalidOperationException($"No background typing strategy succeeded. {messageError}.{suffix}");
    }

    private object Scroll(JsonElement request)
    {
        var entry = GetElement(request);
        var direction = request.TryGetProperty("direction", out var directionNode)
            ? directionNode.GetString()?.ToLowerInvariant()
            : null;
        if (direction is not ("up" or "down")) throw new ArgumentException("Scroll direction must be 'up' or 'down'.");
        var steps = Math.Clamp(GetInt(request, "steps", 3), 1, 100);
        var allowForeground = GetBool(request, "allowForegroundFallback", false);
        var forceForeground = GetBool(request, "foreground", false);
        if (forceForeground && !allowForeground)
            throw new InvalidOperationException("foreground=true also requires allowForegroundFallback=true.");
        leases.Touch(entry.ProcessId, entry.RootWindow);
        windows.EnsureVisible(entry.RootWindow);

        if (forceForeground)
        {
            if (NativeInput.ScrollForeground(entry, direction == "down", steps, out var forcedError))
                return ActionResult.Ok(entry, "SendInput-forced", backgroundSafe: false,
                    warning: "Explicit foreground input briefly used and restored the system pointer. Verify the scroll position.");
            throw new InvalidOperationException($"Forced foreground scroll failed for {entry.Id}: {forcedError}");
        }

        var scrollEntry = FindScrollableEntry(entry);
        if (scrollEntry is not null && TryScrollPattern(scrollEntry.Element, direction == "down", steps))
        {
            return ActionResult.Ok(entry, scrollEntry.Id == entry.Id ? "ScrollPattern" : $"ScrollPattern({scrollEntry.Id})", backgroundSafe: true);
        }

        if (NativeInput.ScrollWindowMessage(entry, direction == "down", steps, out var messageError))
        {
            return ActionResult.Ok(entry, "window-message-wheel", backgroundSafe: true,
                warning: "Wheel messages were sent at the element center. Verify the resulting scroll position with getChanges().");
        }

        var foregroundError = string.Empty;
        if (allowForeground && NativeInput.ScrollForeground(entry, direction == "down", steps, out foregroundError))
        {
            return ActionResult.Ok(entry, "SendInput", backgroundSafe: false,
                warning: "Foreground fallback briefly moved the system pointer; it was restored afterward.");
        }

        var suffix = allowForeground ? $" Foreground fallback also failed: {foregroundError}" : " Pass { allowForegroundFallback: true } only if temporarily taking foreground input is acceptable.";
        throw new InvalidOperationException($"No background scroll strategy succeeded for {entry.Id}. {messageError}.{suffix}");
    }

    private object? Release(JsonElement request)
    {
        if (request.TryGetProperty("pid", out var pidNode) && pidNode.ValueKind == JsonValueKind.Number)
        {
            leases.Release(pidNode.GetInt32());
        }
        else
        {
            leases.ReleaseAll();
        }
        return null;
    }

    private SnapshotState BuildSnapshot(WindowInfo window, SnapshotOptions options)
    {
        var useSubtreeCache = !options.RawView && options.MaxDepth >= 8 && options.MaxElements >= 500;
        var cache = CreateSnapshotCache(useSubtreeCache);
        var root = automation.ElementFromHandleBuildCache(new Windows.Win32.Foundation.HWND((nint)window.Handle), cache);
        var walker = options.RawView ? automation.RawViewWalker : automation.ControlViewWalker;

        var nodes = new List<SnapshotNode>();
        var entries = new List<ElementEntry>();
        var visualEntries = new List<VisualEntry>();
        var usedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var output = new StringBuilder();
        var truncated = false;
        var visited = 0;

        void Visit(IUIAutomationElement element, int depth, string? parentId, string path)
        {
            if (visited >= options.MaxElements)
            {
                truncated = true;
                return;
            }
            visited++;

            var node = ReadNode(element, window, depth, parentId, path, usedIds, nodes.Count);
            entries.Add(new ElementEntry(node.Id, window.ProcessId, window.Handle, element, parentId, node.Bounds,
                SafeComBool(() => element.CachedHasKeyboardFocus, false)));
            var include = (!options.VisibleOnly || !SafeComBool(() => element.CachedIsOffscreen, false))
                && (!options.InteractiveOnly || IsInteractive(element));
            if (include)
            {
                nodes.Add(node with { Order = nodes.Count });
                output.Append(' ', options.InteractiveOnly ? 0 : depth * 2).AppendLine(node.Formatted);
            }

            if (depth >= options.MaxDepth) return;
            if (useSubtreeCache)
            {
                IUIAutomationElementArray children;
                try { children = element.GetCachedChildren(); }
                catch { return; }
                if (children is null) return;
                for (var index = 0; index < children.Length && !truncated; index++)
                    Visit(children.GetElement(index), depth + 1, node.Id, $"{path}/{index}");
            }
            else
            {
                IUIAutomationElement? child;
                try { child = walker.GetFirstChildElementBuildCache(element, cache); }
                catch { return; }
                var index = 0;
                while (child is not null && !truncated)
                {
                    Visit(child, depth + 1, node.Id, $"{path}/{index++}");
                    try { child = walker.GetNextSiblingElementBuildCache(child, cache); }
                    catch { child = null; }
                }
            }
        }

        Visit(root, 0, null, "0");
        if (truncated)
        {
            output.AppendLine($"... truncated after {options.MaxElements} UIA elements (raise maxElements to inspect more)");
        }

        // Custom Qt/GPU/Electron surfaces often expose a shallow stack of unnamed
        // panes plus title-bar controls. Treat that as barren even though it is
        // technically more than one UIA node.
        var shouldUseVision = options.VisualFallback == "always"
            || (options.VisualFallback == "auto" && nodes.Count <= 20 && window.Rect.Width >= 200 && window.Rect.Height >= 100);
        if (shouldUseVision)
        {
            var visual = VisualCapture.Recognize(window, Math.Min(options.MaxElements, 1000));
            output.AppendLine().Append("[visual fallback: ").Append(visual.Status).AppendLine("]");
            foreach (var hit in visual.Entries)
            {
                visualEntries.Add(hit);
                var formatted = $"{hit.Id} VisualText \"{Escape(hit.Text)}\" ({Round(hit.Bounds.X)},{Round(hit.Bounds.Y)} {Round(hit.Bounds.Width)}x{Round(hit.Bounds.Height)}) [ocr:{hit.Confidence:0}]";
                nodes.Add(new SnapshotNode(hit.Id, null, 0, nodes.Count, hit.Bounds, formatted,
                    string.Join("\u001f", hit.Text, Round(hit.Bounds.X), Round(hit.Bounds.Y), Round(hit.Bounds.Width), Round(hit.Bounds.Height))));
                output.AppendLine(formatted);
            }
            if (visual.Entries.Count == 0)
                output.AppendLine("(no readable OCR text; do not guess coordinates from this snapshot)");
        }

        return new SnapshotState(window.ProcessId, window.Handle, output.ToString().TrimEnd(), nodes, entries, visualEntries);
    }

    private IUIAutomationCacheRequest CreateSnapshotCache(bool subtree)
    {
        var cache = automation.CreateCacheRequest();
        cache.TreeScope = subtree
            ? Windows.Win32.UI.Accessibility.TreeScope.TreeScope_Subtree
            : Windows.Win32.UI.Accessibility.TreeScope.TreeScope_Element;
        cache.AutomationElementMode = Windows.Win32.UI.Accessibility.AutomationElementMode.AutomationElementMode_Full;
        foreach (var property in new[]
        {
            UIA_PROPERTY_ID.UIA_RuntimeIdPropertyId,
            UIA_PROPERTY_ID.UIA_BoundingRectanglePropertyId,
            UIA_PROPERTY_ID.UIA_ControlTypePropertyId,
            UIA_PROPERTY_ID.UIA_NamePropertyId,
            UIA_PROPERTY_ID.UIA_AutomationIdPropertyId,
            UIA_PROPERTY_ID.UIA_ClassNamePropertyId,
            UIA_PROPERTY_ID.UIA_IsEnabledPropertyId,
            UIA_PROPERTY_ID.UIA_IsOffscreenPropertyId,
            UIA_PROPERTY_ID.UIA_IsKeyboardFocusablePropertyId,
            UIA_PROPERTY_ID.UIA_HasKeyboardFocusPropertyId,
            UIA_PROPERTY_ID.UIA_ValueValuePropertyId,
            UIA_PROPERTY_ID.UIA_ValueIsReadOnlyPropertyId,
            UIA_PROPERTY_ID.UIA_ToggleToggleStatePropertyId,
            UIA_PROPERTY_ID.UIA_ExpandCollapseExpandCollapseStatePropertyId,
            UIA_PROPERTY_ID.UIA_ScrollVerticallyScrollablePropertyId,
            UIA_PROPERTY_ID.UIA_ScrollHorizontallyScrollablePropertyId,
        }) cache.AddProperty(property);
        foreach (var pattern in new[]
        {
            UIA_PATTERN_ID.UIA_InvokePatternId,
            UIA_PATTERN_ID.UIA_ValuePatternId,
            UIA_PATTERN_ID.UIA_TogglePatternId,
            UIA_PATTERN_ID.UIA_SelectionItemPatternId,
            UIA_PATTERN_ID.UIA_ExpandCollapsePatternId,
            UIA_PATTERN_ID.UIA_ScrollPatternId,
        }) cache.AddPattern(pattern);
        return cache;
    }

    private static bool IsInteractive(IUIAutomationElement element)
    {
        if (SafeComBool(() => element.CachedIsKeyboardFocusable, false)) return true;
        return HasCachedPattern(element, UIA_PATTERN_ID.UIA_InvokePatternId)
            || HasCachedPattern(element, UIA_PATTERN_ID.UIA_ValuePatternId)
            || HasCachedPattern(element, UIA_PATTERN_ID.UIA_TogglePatternId)
            || HasCachedPattern(element, UIA_PATTERN_ID.UIA_SelectionItemPatternId)
            || HasCachedPattern(element, UIA_PATTERN_ID.UIA_ExpandCollapsePatternId)
            || HasCachedPattern(element, UIA_PATTERN_ID.UIA_ScrollPatternId);
    }

    private static bool HasCachedPattern(IUIAutomationElement element, UIA_PATTERN_ID pattern)
    {
        try { return element.GetCachedPattern(pattern) is not null; }
        catch { return false; }
    }

    private static SnapshotNode ReadNode(
        IUIAutomationElement element,
        WindowInfo window,
        int depth,
        string? parentId,
        string path,
        HashSet<string> usedIds,
        int order)
    {
        var controlType = GetControlTypeName(element.CachedControlType);
        var name = SafeComString(() => element.CachedName);
        var automationId = SafeComString(() => element.CachedAutomationId);
        var className = SafeComString(() => element.CachedClassName);
        var rect = element.CachedBoundingRectangle;
        var bounds = new ElementBounds(rect.left, rect.top, Math.Max(0, rect.right - rect.left), Math.Max(0, rect.bottom - rect.top));
        var identity = RuntimeIdentity(element) ?? $"{path}|{automationId}|{controlType}|{name}|{className}";
        var id = StableElementId(controlType, window.ProcessId, identity, usedIds, automationId, name);
        var value = CachedValue(element);
        var offscreen = SafeComBool(() => element.CachedIsOffscreen, false);
        var enabled = SafeComBool(() => element.CachedIsEnabled, true);
        var focusable = SafeComBool(() => element.CachedIsKeyboardFocusable, false);
        var focused = SafeComBool(() => element.CachedHasKeyboardFocus, false);
        var flags = new List<string>();
        if (!enabled) flags.Add("disabled");
        if (offscreen) flags.Add("offscreen");
        if (focusable) flags.Add("focusable");
        if (focused) flags.Add("focused");
        try
        {
            var toggle = (IUIAutomationTogglePattern)element.GetCachedPattern(UIA_PATTERN_ID.UIA_TogglePatternId);
            flags.Add(toggle.CachedToggleState switch
            {
                Windows.Win32.UI.Accessibility.ToggleState.ToggleState_On => "on",
                Windows.Win32.UI.Accessibility.ToggleState.ToggleState_Off => "off",
                _ => "indeterminate",
            });
        }
        catch { }
        try
        {
            var expand = (IUIAutomationExpandCollapsePattern)element.GetCachedPattern(UIA_PATTERN_ID.UIA_ExpandCollapsePatternId);
            var state = expand.CachedExpandCollapseState;
            if (state == Windows.Win32.UI.Accessibility.ExpandCollapseState.ExpandCollapseState_Expanded) flags.Add("expanded");
            else if (state == Windows.Win32.UI.Accessibility.ExpandCollapseState.ExpandCollapseState_Collapsed) flags.Add("collapsed");
        }
        catch { }
        try
        {
            var scroll = (IUIAutomationScrollPattern)element.GetCachedPattern(UIA_PATTERN_ID.UIA_ScrollPatternId);
            var vertical = (bool)scroll.CachedVerticallyScrollable;
            var horizontal = (bool)scroll.CachedHorizontallyScrollable;
            if (vertical || horizontal) flags.Add(vertical && horizontal ? "scroll:vh" : vertical ? "scroll:v" : "scroll:h");
        }
        catch { }

        var formatted = new StringBuilder()
            .Append(id).Append(' ').Append(controlType);
        if (!string.IsNullOrWhiteSpace(name)) formatted.Append(" \"").Append(Escape(name)).Append('"');
        if (!string.IsNullOrWhiteSpace(value) && !string.Equals(value, name, StringComparison.Ordinal))
            formatted.Append(" value=\"").Append(Escape(value, 500)).Append('"');
        if (!bounds.IsEmpty)
            formatted.Append(" (").Append(Round(bounds.X)).Append(',').Append(Round(bounds.Y)).Append(' ')
                .Append(Round(bounds.Width)).Append('x').Append(Round(bounds.Height)).Append(')');
        if (flags.Count > 0) formatted.Append(" [").Append(string.Join(' ', flags)).Append(']');

        var signature = string.Join("\u001f", controlType, name, value, automationId, className,
            Round(bounds.X), Round(bounds.Y), Round(bounds.Width), Round(bounds.Height), string.Join(',', flags), parentId ?? string.Empty, depth);
        return new SnapshotNode(id, parentId, depth, order, bounds, formatted.ToString(), signature);
    }

    private static string CachedValue(IUIAutomationElement element)
    {
        try
        {
            var pattern = (IUIAutomationValuePattern)element.GetCachedPattern(UIA_PATTERN_ID.UIA_ValuePatternId);
            return pattern.CachedValue.ToString() ?? string.Empty;
        }
        catch { return string.Empty; }
    }

    private static string SafeComString(Func<Windows.Win32.Foundation.BSTR> getter)
    {
        try { return getter().ToString() ?? string.Empty; }
        catch { return string.Empty; }
    }

    private static bool SafeComBool(Func<Windows.Win32.Foundation.BOOL> getter, bool fallback)
    {
        try { return (bool)getter(); }
        catch { return fallback; }
    }

    private static unsafe string? RuntimeIdentity(IUIAutomationElement element)
    {
        try
        {
            var array = element.GetRuntimeId();
            if (array is null) return null;
            var count = (int)array->rgsabound[0].cElements;
            var data = (int*)array->pvData;
            var builder = new StringBuilder(count * 6);
            for (var index = 0; index < count; index++) builder.Append(data[index]).Append('.');
            return builder.ToString();
        }
        catch { return null; }
    }

    private static string GetControlTypeName(UIA_CONTROLTYPE_ID type) => type switch
    {
        UIA_CONTROLTYPE_ID.UIA_ButtonControlTypeId => "Button", UIA_CONTROLTYPE_ID.UIA_CalendarControlTypeId => "Calendar",
        UIA_CONTROLTYPE_ID.UIA_CheckBoxControlTypeId => "CheckBox", UIA_CONTROLTYPE_ID.UIA_ComboBoxControlTypeId => "ComboBox",
        UIA_CONTROLTYPE_ID.UIA_EditControlTypeId => "Edit", UIA_CONTROLTYPE_ID.UIA_HyperlinkControlTypeId => "Hyperlink",
        UIA_CONTROLTYPE_ID.UIA_ImageControlTypeId => "Image", UIA_CONTROLTYPE_ID.UIA_ListItemControlTypeId => "ListItem",
        UIA_CONTROLTYPE_ID.UIA_ListControlTypeId => "List", UIA_CONTROLTYPE_ID.UIA_MenuControlTypeId => "Menu",
        UIA_CONTROLTYPE_ID.UIA_MenuBarControlTypeId => "MenuBar", UIA_CONTROLTYPE_ID.UIA_MenuItemControlTypeId => "MenuItem",
        UIA_CONTROLTYPE_ID.UIA_ProgressBarControlTypeId => "ProgressBar", UIA_CONTROLTYPE_ID.UIA_RadioButtonControlTypeId => "RadioButton",
        UIA_CONTROLTYPE_ID.UIA_ScrollBarControlTypeId => "ScrollBar", UIA_CONTROLTYPE_ID.UIA_SliderControlTypeId => "Slider",
        UIA_CONTROLTYPE_ID.UIA_SpinnerControlTypeId => "Spinner", UIA_CONTROLTYPE_ID.UIA_StatusBarControlTypeId => "StatusBar",
        UIA_CONTROLTYPE_ID.UIA_TabControlTypeId => "Tab", UIA_CONTROLTYPE_ID.UIA_TabItemControlTypeId => "TabItem",
        UIA_CONTROLTYPE_ID.UIA_TextControlTypeId => "Text", UIA_CONTROLTYPE_ID.UIA_ToolBarControlTypeId => "ToolBar",
        UIA_CONTROLTYPE_ID.UIA_ToolTipControlTypeId => "ToolTip", UIA_CONTROLTYPE_ID.UIA_TreeControlTypeId => "Tree",
        UIA_CONTROLTYPE_ID.UIA_TreeItemControlTypeId => "TreeItem", UIA_CONTROLTYPE_ID.UIA_GroupControlTypeId => "Group",
        UIA_CONTROLTYPE_ID.UIA_ThumbControlTypeId => "Thumb", UIA_CONTROLTYPE_ID.UIA_DataGridControlTypeId => "DataGrid",
        UIA_CONTROLTYPE_ID.UIA_DataItemControlTypeId => "DataItem", UIA_CONTROLTYPE_ID.UIA_DocumentControlTypeId => "Document",
        UIA_CONTROLTYPE_ID.UIA_SplitButtonControlTypeId => "SplitButton", UIA_CONTROLTYPE_ID.UIA_WindowControlTypeId => "Window",
        UIA_CONTROLTYPE_ID.UIA_PaneControlTypeId => "Pane", UIA_CONTROLTYPE_ID.UIA_HeaderControlTypeId => "Header",
        UIA_CONTROLTYPE_ID.UIA_HeaderItemControlTypeId => "HeaderItem", UIA_CONTROLTYPE_ID.UIA_TableControlTypeId => "Table",
        UIA_CONTROLTYPE_ID.UIA_TitleBarControlTypeId => "TitleBar", UIA_CONTROLTYPE_ID.UIA_SeparatorControlTypeId => "Separator",
        UIA_CONTROLTYPE_ID.UIA_AppBarControlTypeId => "AppBar", UIA_CONTROLTYPE_ID.UIA_SemanticZoomControlTypeId => "SemanticZoom",
        _ => $"Unknown({(int)type})",
    };

    private static string FormatChanges(SnapshotState previous, SnapshotState current)
    {
        var before = previous.Nodes.ToDictionary(node => node.Id, StringComparer.OrdinalIgnoreCase);
        var after = current.Nodes.ToDictionary(node => node.Id, StringComparer.OrdinalIgnoreCase);
        var lines = new List<string>();

        foreach (var node in current.Nodes)
        {
            if (!before.TryGetValue(node.Id, out var old))
            {
                lines.Add($"{new string(' ', node.Depth * 2)}+ {node.Formatted}");
            }
            else if (!string.Equals(old.Signature, node.Signature, StringComparison.Ordinal))
            {
                lines.Add($"{new string(' ', node.Depth * 2)}~ {node.Formatted}");
            }
        }
        foreach (var node in previous.Nodes)
        {
            if (!after.ContainsKey(node.Id))
            {
                lines.Add($"{new string(' ', node.Depth * 2)}- {node.Formatted}");
            }
        }

        return lines.Count == 0 ? "(no semantic or visual changes)" : string.Join(Environment.NewLine, lines);
    }

    private WindowInfo? PreferredWindow(int pid)
    {
        if (!preferredWindows.TryGetValue(pid, out var handle)) return null;
        return windows.List(includeHidden: true, includeUntitled: true).FirstOrDefault(window => window.Handle == handle);
    }

    private WindowInfo ResolveWindow(JsonElement request, bool requireExplicitHandle = false)
    {
        if (request.TryGetProperty("window", out var windowNode) && windowNode.ValueKind == JsonValueKind.String)
        {
            var value = windowNode.GetString();
            if (!TryParseHandle(value, out var handle))
                throw new ArgumentException("window must be a hexadecimal HWND such as '0x13052E' from computer.windows().");
            var exact = windows.FindByHandle(handle)
                ?? throw new InvalidOperationException($"Window {value} no longer exists. Refresh computer.windows() and select its current handle.");
            preferredWindows[exact.ProcessId] = exact.Handle;
            lastActivePid = exact.ProcessId;
            return exact;
        }
        if (requireExplicitHandle)
            throw new ArgumentException("An exact window handle from computer.windows() is required.");
        if (request.TryGetProperty("pid", out var pidNode) && pidNode.TryGetInt32(out var requestedPid) && requestedPid > 0)
        {
            return PreferredWindow(requestedPid) ?? windows.BestForProcess(requestedPid)
                ?? throw new InvalidOperationException($"No top-level window was found for PID {requestedPid}.");
        }
        if (lastActivePid is { } pid)
        {
            return PreferredWindow(pid) ?? windows.BestForProcess(pid)
                ?? throw new InvalidOperationException($"No top-level window was found for PID {pid}.");
        }
        throw new InvalidOperationException("No active computer window. Call computer.open(), focusWindow(handle), snapshot(handle), or pass { window }.");
    }

    private static bool TryParseHandle(string? value, out IntPtr handle)
    {
        handle = IntPtr.Zero;
        if (string.IsNullOrWhiteSpace(value)) return false;
        var normalized = value.Trim();
        if (!normalized.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return false;
        if (!long.TryParse(normalized[2..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var parsed) || parsed == 0) return false;
        handle = new IntPtr(parsed);
        return true;
    }

    private ElementEntry GetElement(JsonElement request)
    {
        var id = request.TryGetProperty("elementId", out var node) ? node.GetString() : null;
        if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException("elementId must not be empty.");
        if (!elements.TryGetValue(id, out var entry))
            throw new KeyNotFoundException($"Unknown or stale UIA element ID '{id}'. Refresh computer.snapshot(pid) and use an ID from the current tree.");
        return entry;
    }

    private ElementEntry? FindScrollableEntry(ElementEntry start)
    {
        ElementEntry? current = start;
        while (current is not null)
        {
            try
            {
                var scroll = (IUIAutomationScrollPattern)current.Element.GetCurrentPattern(UIA_PATTERN_ID.UIA_ScrollPatternId);
                if ((bool)scroll.CurrentVerticallyScrollable)
                {
                    return current;
                }
            }
            catch { }
            current = current.ParentId is not null && elements.TryGetValue(current.ParentId, out var parent) ? parent : null;
        }
        return null;
    }

    private static bool TryInvoke(IUIAutomationElement element, out string? strategy)
    {
        strategy = null;
        try
        {
            var invoke = (IUIAutomationInvokePattern)element.GetCurrentPattern(UIA_PATTERN_ID.UIA_InvokePatternId);
            invoke.Invoke(); strategy = "InvokePattern"; return true;
        }
        catch { }
        try { ((IUIAutomationTogglePattern)element.GetCurrentPattern(UIA_PATTERN_ID.UIA_TogglePatternId)).Toggle(); strategy = "TogglePattern"; return true; } catch { }
        try { ((IUIAutomationSelectionItemPattern)element.GetCurrentPattern(UIA_PATTERN_ID.UIA_SelectionItemPatternId)).Select(); strategy = "SelectionItemPattern"; return true; } catch { }
        try
        {
            var expand = (IUIAutomationExpandCollapsePattern)element.GetCurrentPattern(UIA_PATTERN_ID.UIA_ExpandCollapsePatternId);
            if (expand.CurrentExpandCollapseState == Windows.Win32.UI.Accessibility.ExpandCollapseState.ExpandCollapseState_Expanded) expand.Collapse();
            else expand.Expand();
            strategy = "ExpandCollapsePattern"; return true;
        }
        catch { }
        return false;
    }

    private static unsafe bool TrySetValue(IUIAutomationElement element, string text, out string? strategy)
    {
        strategy = null;
        try
        {
            var value = (IUIAutomationValuePattern)element.GetCurrentPattern(UIA_PATTERN_ID.UIA_ValuePatternId);
            if (!(bool)value.CurrentIsReadOnly)
            {
                var pointer = Marshal.StringToBSTR(text);
                try
                {
                    value.SetValue(new Windows.Win32.Foundation.BSTR((char*)pointer));
                    strategy = "ValuePattern";
                    return true;
                }
                finally { Marshal.FreeBSTR(pointer); }
            }
        }
        catch { }
        return false;
    }

    private static bool TryScrollPattern(IUIAutomationElement element, bool down, int steps)
    {
        try
        {
            var pattern = (IUIAutomationScrollPattern)element.GetCurrentPattern(UIA_PATTERN_ID.UIA_ScrollPatternId);
            if (!(bool)pattern.CurrentVerticallyScrollable) return false;
            var current = pattern.CurrentVerticalScrollPercent;
            pattern.SetScrollPercent(-1, Math.Clamp(current + (down ? 5d : -5d) * steps, 0, 100));
            return true;
        }
        catch { return false; }
    }

    private static string StableElementId(string controlType, int pid, string identity, HashSet<string> used, string? automationId = null, string? name = null)
    {
        var prefix = controlType.ToLowerInvariant() switch
        {
            "button" => "btn", "edit" => "edt", "text" => "txt", "document" => "doc",
            "pane" => "pn", "window" => "win", "group" => "grp", "hyperlink" => "lnk",
            "image" => "img", "list" => "lst", "listitem" => "li", "menu" => "mnu",
            "menuitem" => "mi", "tab" => "tab", "tabitem" => "ti", "checkbox" => "chk",
            "radiobutton" => "radio", "combobox" => "combo", "tree" => "tree", "treeitem" => "tri",
            "slider" => "sld", "progressbar" => "prog", "toolbar" => "bar", "titlebar" => "title",
            _ => "el",
        };
        var hash = Fnv1a($"{pid}|{identity}").ToString("x8", CultureInfo.InvariantCulture);
        var semantic = NormalizeSlug(automationId) ?? NormalizeSlug(name);
        var baseId = semantic is null ? $"{prefix}-{hash[..4]}" : $"{prefix}-{semantic}-{hash[..4]}";
        var candidate = baseId;
        var suffix = 2;
        while (!used.Add(candidate)) candidate = $"{baseId}-{suffix++}";
        return candidate;
    }

    private static string? NormalizeSlug(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = Regex.Replace(value.ToLowerInvariant(), "[^a-z0-9]", string.Empty);
        if (normalized.Length == 0) return null;
        return normalized.Length > 15 ? normalized[..15] : normalized;
    }

    private static uint Fnv1a(string value)
    {
        var hash = 2166136261u;
        foreach (var item in Encoding.UTF8.GetBytes(value))
        {
            hash ^= item;
            hash *= 16777619;
        }
        return hash;
    }

    private static string Escape(string value, int maxLength = 300)
    {
        var compact = Regex.Replace(value, @"\s+", " ").Trim();
        if (compact.Length > maxLength) compact = compact[..maxLength] + "…";
        return compact.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);
    }

    private static int Round(double value) => double.IsNaN(value) || double.IsInfinity(value) ? 0 : (int)Math.Round(value);
    private static int GetRequiredPid(JsonElement request)
        => request.TryGetProperty("pid", out var node) && node.TryGetInt32(out var pid) && pid > 0
            ? pid
            : throw new ArgumentException("pid must be a positive integer.");
    private static bool GetBool(JsonElement request, string name, bool fallback)
        => request.TryGetProperty(name, out var node) && node.ValueKind is JsonValueKind.True or JsonValueKind.False ? node.GetBoolean() : fallback;
    private static int GetInt(JsonElement request, string name, int fallback)
        => request.TryGetProperty(name, out var node) && node.TryGetInt32(out var result) ? result : fallback;
    private static string GetString(JsonElement request, string name, string fallback)
        => request.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String ? node.GetString() ?? fallback : fallback;
    private static bool Contains(RectInt rect, PointInt point)
        => point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom;
}

internal sealed class WindowManager
{
    private readonly ConcurrentDictionary<int, CachedProcessMetadata> processMetadata = new();

    public IReadOnlyList<WindowInfo> List(bool includeHidden = true, bool includeUntitled = false)
    {
        var result = new List<WindowInfo>();
        var foreground = NativeMethods.GetForegroundWindow();
        var zOrder = 0;
        NativeMethods.EnumWindows((handle, _) =>
        {
            var currentZOrder = zOrder++;
            if (handle == IntPtr.Zero) return true;
            NativeMethods.GetWindowThreadProcessId(handle, out var rawPid);
            var pid = unchecked((int)rawPid);
            if (pid <= 0 || pid == Environment.ProcessId) return true;
            var visible = NativeMethods.IsWindowVisible(handle);
            if (!includeHidden && !visible) return true;

            var titleLength = NativeMethods.GetWindowTextLength(handle);
            var titleBuilder = new StringBuilder(Math.Max(1, titleLength + 1));
            NativeMethods.GetWindowText(handle, titleBuilder, titleBuilder.Capacity);
            var title = titleBuilder.ToString().Trim();
            if (!includeUntitled && title.Length == 0) return true;

            NativeMethods.GetClassName(handle, titleBuilder.Clear(), titleBuilder.Capacity = 512);
            var className = titleBuilder.ToString();
            NativeMethods.GetWindowRect(handle, out var rect);
            var cloaked = false;
            try
            {
                var value = 0;
                if (NativeMethods.DwmGetWindowAttribute(handle, 14, ref value, sizeof(int)) == 0) cloaked = value != 0;
            }
            catch { }

            var metadata = GetProcessMetadata(pid);

            var owner = NativeMethods.GetWindow(handle, 4); // GW_OWNER
            result.Add(new WindowInfo(handle, pid, title, metadata.ProcessName, metadata.ExecutablePath, className, visible,
                NativeMethods.IsIconic(handle), cloaked, rect, owner, currentZOrder, handle == foreground));
            return true;
        }, IntPtr.Zero);

        return result
            .OrderByDescending(ScoreWindowQuality)
            .ThenBy(window => window.ProcessName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(window => window.Title, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private CachedProcessMetadata GetProcessMetadata(int pid)
    {
        var now = DateTimeOffset.UtcNow;
        if (processMetadata.TryGetValue(pid, out var cached) && now - cached.CapturedAt < TimeSpan.FromSeconds(30))
            return cached;

        var processName = string.Empty;
        string? executablePath = null;
        try
        {
            using var process = Process.GetProcessById(pid);
            processName = process.ProcessName;
            try { executablePath = process.MainModule?.FileName; } catch { }
        }
        catch { }
        var result = new CachedProcessMetadata(processName, executablePath, now);
        processMetadata[pid] = result;
        return result;
    }

    public WindowInfo? BestForProcess(int pid)
        => List(includeHidden: true, includeUntitled: true)
            .Where(window => window.ProcessId == pid)
            .OrderByDescending(ScoreWindowQuality)
            .FirstOrDefault();

    public WindowInfo? FindByHandle(IntPtr handle)
        => List(includeHidden: true, includeUntitled: true)
            .FirstOrDefault(window => window.Handle == handle);

    public WindowInfo? WaitForProcessWindow(int pid, int timeoutMs)
    {
        var stopwatch = Stopwatch.StartNew();
        do
        {
            var match = BestForProcess(pid);
            if (match is not null) return match;
            Thread.Sleep(100);
        } while (stopwatch.ElapsedMilliseconds < timeoutMs);
        return null;
    }

    public void EnsureVisible(IntPtr handle)
    {
        if (handle == IntPtr.Zero || !NativeMethods.IsWindow(handle)) return;
        if (NativeMethods.IsIconic(handle))
        {
            // Electron/Chromium UIA providers can block indefinitely while
            // iconic. SW_SHOWNOACTIVATE does not consistently leave the iconic
            // state, so use the real restore command when necessary.
            NativeMethods.ShowWindowAsync(handle, 9); // SW_RESTORE
            for (var index = 0; index < 10 && NativeMethods.IsIconic(handle); index++) Thread.Sleep(20);
        }
        else if (!NativeMethods.IsWindowVisible(handle))
        {
            NativeMethods.ShowWindowAsync(handle, 4); // SW_SHOWNOACTIVATE
        }

        if (!NativeMethods.GetWindowRect(handle, out var rect)) return;
        var virtualLeft = NativeMethods.GetSystemMetrics(76);
        var virtualTop = NativeMethods.GetSystemMetrics(77);
        var virtualWidth = NativeMethods.GetSystemMetrics(78);
        var virtualHeight = NativeMethods.GetSystemMetrics(79);
        var intersectionWidth = Math.Max(0, Math.Min(rect.Right, virtualLeft + virtualWidth) - Math.Max(rect.Left, virtualLeft));
        var intersectionHeight = Math.Max(0, Math.Min(rect.Bottom, virtualTop + virtualHeight) - Math.Max(rect.Top, virtualTop));
        if (intersectionWidth < 50 || intersectionHeight < 50)
        {
            NativeMethods.SetWindowPos(handle, IntPtr.Zero, virtualLeft + 32, virtualTop + 32, 0, 0,
                0x0001 | 0x0004 | 0x0010 | 0x0040); // NOSIZE | NOZORDER | NOACTIVATE | SHOWWINDOW
        }
    }

    public static double ScoreWindowQuality(WindowInfo window)
    {
        var score = 0d;
        if (window.Visible) score += 5;
        if (!window.Minimized) score += 2;
        if (!window.Cloaked) score += 2;
        if (!string.IsNullOrWhiteSpace(window.Title)) score += 2;
        if (window.Rect.Width >= 200 && window.Rect.Height >= 100) score += 1;
        if (window.ClassName is "Progman" or "WorkerW" or "Shell_TrayWnd") score -= 10;
        if (window.ClassName.Contains("IME", StringComparison.OrdinalIgnoreCase)) score -= 20;
        if (!window.Minimized && (window.Rect.Width < 80 || window.Rect.Height < 40)) score -= 8;
        return score;
    }

    public static bool IsLikelyAppWindow(WindowInfo window)
        => !string.IsNullOrWhiteSpace(window.Title)
            && !window.ClassName.Contains("IME", StringComparison.OrdinalIgnoreCase)
            && (window.Minimized || (window.Rect.Width >= 80 && window.Rect.Height >= 40));
}

internal sealed class AppResolver
{
    private readonly WindowManager windows;
    private readonly object catalogLock = new();
    private DateTimeOffset catalogAt = DateTimeOffset.MinValue;
    private List<AppCandidate> installed = new();

    public AppResolver(WindowManager windows) => this.windows = windows;

    public WindowInfo ResolveAndOpen(string query, int timeoutMs)
    {
        var openWindows = windows.List(includeHidden: true, includeUntitled: false);
        var runningCandidates = openWindows.Where(WindowManager.IsLikelyAppWindow).Select(window => new AppCandidate(
            window.Title,
            null,
            null,
            window,
            new[] { window.ProcessName, Path.GetFileNameWithoutExtension(window.ExecutablePath ?? string.Empty) })).ToList();
        var reusable = runningCandidates
            .Select(candidate => new ScoredCandidate(candidate, Score(query, candidate)))
            .Where(item => item.Score >= 0.80)
            .OrderByDescending(item => item.Score)
            .ThenByDescending(item => WindowManager.ScoreWindowQuality(item.Candidate.Window!))
            .FirstOrDefault();
        if (reusable?.Candidate.Window is not null)
        {
            // A strong running match is preferable to an exact Start-menu
            // label: shell-launching an installed entry can create a duplicate
            // instance or activate a launcher even though the app already exists.
            return reusable.Candidate.Window;
        }
        var installedCandidates = GetInstalledApps();
        var scored = runningCandidates.Concat(installedCandidates)
            .Select(candidate => new ScoredCandidate(candidate, Score(query, candidate)))
            .Where(item => item.Score >= 0.42)
            .OrderByDescending(item => item.Score + (item.Candidate.Window is not null ? 0.025 : 0))
            .ThenByDescending(item => item.Candidate.Window is null ? 0 : WindowManager.ScoreWindowQuality(item.Candidate.Window))
            .ThenBy(item => item.Candidate.Name.Length)
            .ToArray();

        if (scored.Length == 0 || scored[0].Score < 0.54)
        {
            var suggestions = installedCandidates
                .Select(candidate => new ScoredCandidate(candidate, Score(query, candidate)))
                .OrderByDescending(item => item.Score)
                .Take(5)
                .Select(item => $"{item.Candidate.Name} ({item.Score:0.00})");
            throw new InvalidOperationException($"Could not confidently resolve installed app '{query}'. Closest candidates: {string.Join(", ", suggestions)}");
        }

        var best = scored[0];
        if (scored.Length > 1 && best.Score < 0.86 && best.Score - scored[1].Score < 0.035
            && !string.Equals(best.Candidate.Name, scored[1].Candidate.Name, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"App name '{query}' is ambiguous between '{best.Candidate.Name}' and '{scored[1].Candidate.Name}'. Use a more specific name or a PID from computer.windows().");
        }

        if (best.Candidate.Window is not null)
        {
            return best.Candidate.Window;
        }

        Launch(best.Candidate);
        var stopwatch = Stopwatch.StartNew();
        do
        {
            Thread.Sleep(100);
            var match = windows.List(includeHidden: true, includeUntitled: false)
                .Where(WindowManager.IsLikelyAppWindow)
                .Select(window => new { Window = window, Score = Score(query, new AppCandidate(window.Title, null, null, window, new[] { window.ProcessName })) })
                .OrderByDescending(item => item.Score + WindowManager.ScoreWindowQuality(item.Window) * 0.002)
                .FirstOrDefault();
            if (match is not null && match.Score >= 0.52)
            {
                return match.Window;
            }
        } while (stopwatch.ElapsedMilliseconds < timeoutMs);

        throw new TimeoutException($"Launched '{best.Candidate.Name}', but no matching main window appeared within {timeoutMs} ms.");
    }

    private List<AppCandidate> GetInstalledApps()
    {
        lock (catalogLock)
        {
            if (DateTimeOffset.UtcNow - catalogAt < TimeSpan.FromMinutes(5) && installed.Count > 0)
                return installed.ToList();

            var candidates = new List<AppCandidate>();
            candidates.AddRange(ReadStartApps());
            candidates.AddRange(ReadStartMenuLinks());
            candidates.AddRange(ReadAppPaths());
            installed = candidates
                .Where(candidate => !string.IsNullOrWhiteSpace(candidate.Name))
                .GroupBy(candidate => $"{NameMatcher.Normalize(candidate.Name)}|{candidate.AppId}|{candidate.LaunchTarget}", StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .ToList();
            catalogAt = DateTimeOffset.UtcNow;
            return installed.ToList();
        }
    }

    private static IEnumerable<AppCandidate> ReadStartApps()
    {
        var result = new List<AppCandidate>();
        var script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-StartApps | ForEach-Object { [Console]::WriteLine(($_.Name -replace \"`t\",\" \") + \"`t\" + $_.AppID) }";
        var start = new ProcessStartInfo("powershell.exe", $"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{script.Replace("\"", "\\\"")}\"")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        try
        {
            using var process = Process.Start(start);
            if (process is null) return result;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(10_000);
            foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Split('\t', 2);
                if (parts.Length == 2 && parts[0].Trim().Length > 0 && parts[1].Trim().Length > 0)
                    result.Add(new AppCandidate(parts[0].Trim(), parts[1].Trim(), null, null, new[] { parts[1].Trim() }));
            }
        }
        catch { }
        return result;
    }

    private static IEnumerable<AppCandidate> ReadStartMenuLinks()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
        };
        foreach (var root in roots.Where(Directory.Exists))
        {
            string[] links;
            // Materialize inside the try: Windows Start Menu trees can contain
            // protected/junction descendants that throw only during enumeration.
            try { links = Directory.EnumerateFiles(root, "*.lnk", SearchOption.AllDirectories).ToArray(); }
            catch { continue; }
            foreach (var link in links)
            {
                yield return new AppCandidate(Path.GetFileNameWithoutExtension(link), null, link, null,
                    new[] { Path.GetFileName(Path.GetDirectoryName(link)) ?? string.Empty });
            }
        }
    }

    private static IEnumerable<AppCandidate> ReadAppPaths()
    {
        var result = new List<AppCandidate>();
        var roots = new[]
        {
            (Registry.CurrentUser, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"),
            (Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"),
        };
        foreach (var (root, subkey) in roots)
        {
            RegistryKey? key = null;
            try { key = root.OpenSubKey(subkey); } catch { }
            using (key)
            {
                if (key is null) continue;
                foreach (var name in key.GetSubKeyNames())
                {
                    try
                    {
                        using var app = key.OpenSubKey(name);
                        var target = app?.GetValue(null) as string;
                        if (!string.IsNullOrWhiteSpace(target))
                            result.Add(new AppCandidate(Path.GetFileNameWithoutExtension(name), null, target.Trim('"'), null, new[] { name }));
                    }
                    catch { }
                }
            }
        }
        return result;
    }

    private static void Launch(AppCandidate candidate)
    {
        ProcessStartInfo start;
        if (!string.IsNullOrWhiteSpace(candidate.AppId))
        {
            start = new ProcessStartInfo("explorer.exe", $"shell:AppsFolder\\{candidate.AppId}") { UseShellExecute = true };
        }
        else if (!string.IsNullOrWhiteSpace(candidate.LaunchTarget))
        {
            start = new ProcessStartInfo(candidate.LaunchTarget) { UseShellExecute = true };
        }
        else
        {
            throw new InvalidOperationException($"No launch target is available for '{candidate.Name}'.");
        }
        Process.Start(start);
    }

    private static double Score(string query, AppCandidate candidate)
    {
        var aliases = new[] { candidate.Name, candidate.AppId ?? string.Empty, candidate.LaunchTarget ?? string.Empty }
            .Concat(candidate.Aliases)
            .Where(value => !string.IsNullOrWhiteSpace(value));
        return aliases.Max(alias => NameMatcher.Score(query, alias));
    }
}

internal static class NameMatcher
{
    private static readonly Dictionary<string, string> Words = new(StringComparer.OrdinalIgnoreCase)
    {
        ["яндекс"] = "yandex", ["музыка"] = "music", ["музыки"] = "music",
        ["гугл"] = "google", ["хром"] = "chrome", ["браузер"] = "browser", ["калькулятор"] = "calculator",
        ["блокнот"] = "notepad", ["проводник"] = "explorer", ["настройки"] = "settings", ["почта"] = "mail",
        ["камера"] = "camera", ["фото"] = "photos", ["магазин"] = "store", ["терминал"] = "terminal",
        ["телеграм"] = "telegram", ["дискорд"] = "discord", ["ворд"] = "word", ["эксель"] = "excel",
        ["приложение"] = "app", ["программа"] = "app", ["настольный"] = "desktop",
    };
    private static readonly HashSet<string> Generic = new(StringComparer.OrdinalIgnoreCase)
    {
        "app", "application", "desktop", "client", "program", "launcher", "the"
    };

    public static string Normalize(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var lowered = value.ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder();
        foreach (var character in lowered)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.NonSpacingMark) continue;
            builder.Append(char.IsLetterOrDigit(character) ? character : ' ');
        }
        var tokens = Regex.Split(builder.ToString(), @"\s+").Where(token => token.Length > 0)
            .Select(token => Words.TryGetValue(token, out var translated) ? translated : Transliterate(token))
            .Select(token => token.Replace("yandeks", "yandex", StringComparison.Ordinal))
            .ToArray();
        return string.Join(' ', tokens);
    }

    public static double Score(string query, string candidate)
    {
        var left = Normalize(query);
        var right = Normalize(candidate);
        if (left.Length == 0 || right.Length == 0) return 0;
        if (left == right) return 1;
        if (right.StartsWith(left + " ", StringComparison.Ordinal) || right.EndsWith(" " + left, StringComparison.Ordinal)) return 0.94;
        if (left.StartsWith(right + " ", StringComparison.Ordinal) || left.EndsWith(" " + right, StringComparison.Ordinal)) return 0.88;

        var leftTokens = left.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(token => !Generic.Contains(token)).ToHashSet();
        var rightTokens = right.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(token => !Generic.Contains(token)).ToHashSet();
        if (leftTokens.Count == 0) leftTokens = left.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        if (rightTokens.Count == 0) rightTokens = right.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        var intersection = leftTokens.Intersect(rightTokens).Count();
        var precision = intersection / (double)Math.Max(1, rightTokens.Count);
        var recall = intersection / (double)Math.Max(1, leftTokens.Count);
        var tokenF1 = precision + recall == 0 ? 0 : 2 * precision * recall / (precision + recall);
        if (intersection == Math.Min(leftTokens.Count, rightTokens.Count)) tokenF1 = Math.Max(tokenF1, 0.82);

        var edit = 1d - Levenshtein(left, right) / (double)Math.Max(left.Length, right.Length);
        var acronymLeft = string.Concat(leftTokens.Select(token => token[0]));
        var acronymRight = string.Concat(rightTokens.Select(token => token[0]));
        var acronym = acronymLeft == right || acronymRight == left ? 0.84 : 0;
        return Math.Max(acronym, Math.Max(tokenF1, edit * 0.9));
    }

    private static string Transliterate(string value)
    {
        var map = new Dictionary<char, string>
        {
            ['а']="a",['б']="b",['в']="v",['г']="g",['д']="d",['е']="e",['ё']="yo",['ж']="zh",['з']="z",
            ['и']="i",['й']="y",['к']="k",['л']="l",['м']="m",['н']="n",['о']="o",['п']="p",['р']="r",
            ['с']="s",['т']="t",['у']="u",['ф']="f",['х']="kh",['ц']="ts",['ч']="ch",['ш']="sh",['щ']="sch",
            ['ъ']="",['ы']="y",['ь']="",['э']="e",['ю']="yu",['я']="ya",
        };
        var builder = new StringBuilder();
        foreach (var character in value)
            builder.Append(map.TryGetValue(character, out var replacement) ? replacement : character.ToString());
        return builder.ToString();
    }

    private static int Levenshtein(string left, string right)
    {
        var previous = Enumerable.Range(0, right.Length + 1).ToArray();
        for (var i = 1; i <= left.Length; i++)
        {
            var current = new int[right.Length + 1];
            current[0] = i;
            for (var j = 1; j <= right.Length; j++)
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + (left[i - 1] == right[j - 1] ? 0 : 1));
            previous = current;
        }
        return previous[right.Length];
    }
}

internal sealed class InteractionLeaseManager
{
    public const int DefaultLeaseMs = 45_000;
    private readonly WindowManager windows;
    private readonly ConcurrentDictionary<int, Lease> leases = new();
    private readonly Timer timer;

    public InteractionLeaseManager(WindowManager windows)
    {
        this.windows = windows;
        timer = new Timer(Check, null, 750, 750);
    }

    public void Touch(int pid, IntPtr handle, int leaseMs = DefaultLeaseMs)
        => leases[pid] = new Lease(handle, DateTimeOffset.UtcNow.AddMilliseconds(leaseMs), leaseMs);
    public void Release(int pid) => leases.TryRemove(pid, out _);
    public void ReleaseAll() => leases.Clear();

    private void Check(object? state)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var pair in leases)
        {
            if (pair.Value.ExpiresAt <= now)
            {
                leases.TryRemove(pair.Key, out var _removed);
                continue;
            }
            windows.EnsureVisible(pair.Value.Handle);
        }
    }

    private sealed record Lease(IntPtr Handle, DateTimeOffset ExpiresAt, int LeaseMs);
}

internal static class VisualCapture
{
    private static readonly string[] TesseractCandidates =
    {
        Environment.GetEnvironmentVariable("TELOS_TESSERACT_PATH") ?? string.Empty,
        @"C:\Program Files\Tesseract-OCR\tesseract.exe",
        @"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    };

    public static VisualResult Recognize(WindowInfo window, int maxEntries)
    {
        var executable = TesseractCandidates.FirstOrDefault(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
        if (executable is null)
            return new VisualResult(Array.Empty<VisualEntry>(), "OCR unavailable (install Tesseract or set TELOS_TESSERACT_PATH)");

        var tempPath = Path.Combine(Path.GetTempPath(), $"telos-computer-{Environment.ProcessId}-{Guid.NewGuid():N}.png");
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var captureMethod = Capture(window, tempPath);
            var start = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add(tempPath);
            start.ArgumentList.Add("stdout");
            start.ArgumentList.Add("-l");
            start.ArgumentList.Add("eng");
            start.ArgumentList.Add("--psm");
            start.ArgumentList.Add("11");
            start.ArgumentList.Add("tsv");
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Failed to start Tesseract OCR.");
            var tsv = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(5_000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return new VisualResult(Array.Empty<VisualEntry>(), $"{captureMethod}; OCR timed out after 5s");
            }
            if (process.ExitCode != 0)
                return new VisualResult(Array.Empty<VisualEntry>(), $"{captureMethod}; OCR failed: {Compact(error, 180)}");

            var words = ParseTsv(tsv).Where(word => word.Confidence >= 25 && !string.IsNullOrWhiteSpace(word.Text)).ToArray();
            var entries = words
                .GroupBy(word => (word.Block, word.Paragraph, word.Line))
                .Select(group => BuildLine(window, group))
                .Where(entry => entry.Bounds.Width >= 2 && entry.Bounds.Height >= 2)
                .OrderBy(entry => entry.Bounds.Y).ThenBy(entry => entry.Bounds.X)
                .Take(maxEntries)
                .ToArray();
            return new VisualResult(entries, $"{captureMethod}; OCR {stopwatch.ElapsedMilliseconds}ms, {entries.Length} text regions");
        }
        catch (Exception ex)
        {
            return new VisualResult(Array.Empty<VisualEntry>(), $"visual capture failed: {Compact(ex.Message, 220)}");
        }
        finally
        {
            try { File.Delete(tempPath); } catch { }
        }
    }

    private static string Capture(WindowInfo window, string path)
    {
        using var bitmap = new System.Drawing.Bitmap(window.Rect.Width, window.Rect.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var graphics = System.Drawing.Graphics.FromImage(bitmap);
        var hdc = graphics.GetHdc();
        bool printed;
        try { printed = NativeMethods.PrintWindow(window.Handle, hdc, 0x00000002); }
        finally { graphics.ReleaseHdc(hdc); }

        var method = "PrintWindow";
        if (!printed || IsNearlyBlank(bitmap))
        {
            graphics.CopyFromScreen(window.Rect.Left, window.Rect.Top, 0, 0,
                new System.Drawing.Size(window.Rect.Width, window.Rect.Height), System.Drawing.CopyPixelOperation.SourceCopy);
            method = "visible-screen fallback";
        }
        bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        return method;
    }

    private static bool IsNearlyBlank(System.Drawing.Bitmap bitmap)
    {
        var colors = new HashSet<int>();
        for (var row = 1; row <= 8; row++)
        for (var column = 1; column <= 12; column++)
        {
            var x = Math.Clamp(column * bitmap.Width / 13, 0, bitmap.Width - 1);
            var y = Math.Clamp(row * bitmap.Height / 9, 0, bitmap.Height - 1);
            colors.Add(bitmap.GetPixel(x, y).ToArgb());
            if (colors.Count >= 5) return false;
        }
        return true;
    }

    private static IEnumerable<OcrWord> ParseTsv(string tsv)
    {
        foreach (var line in tsv.Split('\n', StringSplitOptions.RemoveEmptyEntries).Skip(1))
        {
            var columns = line.TrimEnd('\r').Split('\t', 12);
            if (columns.Length < 12
                || !int.TryParse(columns[2], out var block)
                || !int.TryParse(columns[3], out var paragraph)
                || !int.TryParse(columns[4], out var lineNumber)
                || !int.TryParse(columns[6], out var left)
                || !int.TryParse(columns[7], out var top)
                || !int.TryParse(columns[8], out var width)
                || !int.TryParse(columns[9], out var height)
                || !double.TryParse(columns[10], NumberStyles.Float, CultureInfo.InvariantCulture, out var confidence))
                continue;
            yield return new OcrWord(block, paragraph, lineNumber, left, top, width, height, confidence, columns[11].Trim());
        }
    }

    private static VisualEntry BuildLine(WindowInfo window, IEnumerable<OcrWord> source)
    {
        var words = source.OrderBy(word => word.Left).ToArray();
        var left = words.Min(word => word.Left);
        var top = words.Min(word => word.Top);
        var right = words.Max(word => word.Left + word.Width);
        var bottom = words.Max(word => word.Top + word.Height);
        var text = string.Join(' ', words.Select(word => word.Text));
        var x = window.Rect.Left + left;
        var y = window.Rect.Top + top;
        var identity = $"{window.Handle.ToInt64():X}|{text.ToLowerInvariant()}|{x / 8}|{y / 8}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).Substring(0, 8).ToLowerInvariant();
        return new VisualEntry($"vis-{hash}", window.ProcessId, window.Handle, text,
            new ElementBounds(x, y, right - left, bottom - top), words.Average(word => word.Confidence));
    }

    private static string Compact(string value, int maxLength)
    {
        var compact = Regex.Replace(value ?? string.Empty, @"\s+", " ").Trim();
        return compact.Length <= maxLength ? compact : compact[..maxLength] + "...";
    }

    private sealed record OcrWord(int Block, int Paragraph, int Line, int Left, int Top, int Width, int Height, double Confidence, string Text);
}

internal static class NativeInput
{
    private const uint WM_MOUSEMOVE = 0x0200;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_MOUSEWHEEL = 0x020A;
    private const uint WM_SETTEXT = 0x000C;
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const uint WM_CHAR = 0x0102;
    private const int VK_CONTROL = 0x11;
    private const int VK_A = 0x41;

    public static bool ActivateWindow(IntPtr rootWindow)
    {
        if (rootWindow == IntPtr.Zero || !NativeMethods.IsWindow(rootWindow)) return false;
        var foreground = NativeMethods.GetForegroundWindow();
        var currentThread = NativeMethods.GetCurrentThreadId();
        var foregroundThread = foreground == IntPtr.Zero ? 0 : NativeMethods.GetWindowThreadProcessId(foreground, out _);
        var targetThread = NativeMethods.GetWindowThreadProcessId(rootWindow, out _);
        var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread
            && NativeMethods.AttachThreadInput(currentThread, foregroundThread, true);
        var attachedTarget = targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread
            && NativeMethods.AttachThreadInput(currentThread, targetThread, true);
        try
        {
            NativeMethods.ShowWindowAsync(rootWindow, 9); // SW_RESTORE
            NativeMethods.BringWindowToTop(rootWindow);
            return NativeMethods.SetForegroundWindow(rootWindow) || NativeMethods.GetForegroundWindow() == rootWindow;
        }
        finally
        {
            if (attachedTarget) NativeMethods.AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) NativeMethods.AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    public static bool ClickWindowMessage(ElementEntry entry, out string error)
    {
        return ClickWindowMessage(entry.RootWindow, Center(entry.Bounds), 1, out error);
    }

    public static bool ClickWindowMessage(IntPtr rootWindow, PointInt point, int clicks, out string error)
    {
        var target = DeepestWindowAt(rootWindow, point);
        if (target == IntPtr.Zero) target = rootWindow;
        var client = point;
        if (!NativeMethods.ScreenToClient(target, ref client))
        {
            error = "ScreenToClient failed";
            return false;
        }
        var lParam = MakeLParam(client.X, client.Y);
        if (!Send(target, WM_MOUSEMOVE, UIntPtr.Zero, lParam))
        {
            error = "The target window rejected or timed out while receiving mouse messages";
            return false;
        }
        for (var index = 0; index < clicks; index++)
        {
            if (!Send(target, WM_LBUTTONDOWN, new UIntPtr(1), lParam)
                || !Send(target, WM_LBUTTONUP, UIntPtr.Zero, lParam))
            {
                error = "The target window rejected or timed out while receiving mouse messages";
                return false;
            }
        }
        error = string.Empty;
        return true;
    }

    public static bool SetTextWindowMessage(ElementEntry entry, string text, out string error)
    {
        var point = Center(entry.Bounds);
        var target = DeepestWindowAt(entry.RootWindow, point);
        if (target == IntPtr.Zero) target = entry.RootWindow;
        if (SendText(target, WM_SETTEXT, text))
        {
            error = string.Empty;
            return true;
        }

        ClickWindowMessage(entry, out _);
        Send(target, WM_KEYDOWN, new UIntPtr(VK_CONTROL), IntPtr.Zero);
        Send(target, WM_KEYDOWN, new UIntPtr(VK_A), IntPtr.Zero);
        Send(target, WM_KEYUP, new UIntPtr(VK_A), IntPtr.Zero);
        Send(target, WM_KEYUP, new UIntPtr(VK_CONTROL), IntPtr.Zero);
        foreach (var character in text)
        {
            if (!Send(target, WM_CHAR, new UIntPtr(character), IntPtr.Zero))
            {
                error = "The target window rejected or timed out while receiving text messages";
                return false;
            }
        }
        error = string.Empty;
        return true;
    }

    public static bool ScrollWindowMessage(ElementEntry entry, bool down, int steps, out string error)
    {
        var point = Center(entry.Bounds);
        var target = DeepestWindowAt(entry.RootWindow, point);
        if (target == IntPtr.Zero) target = entry.RootWindow;
        var lParam = MakeLParam(point.X, point.Y); // WM_MOUSEWHEEL coordinates are screen-relative.
        var client = point;
        NativeMethods.ScreenToClient(target, ref client);
        NativeMethods.PostMessage(target, WM_MOUSEMOVE, UIntPtr.Zero, MakeLParam(client.X, client.Y));
        for (var index = 0; index < steps; index++)
        {
            var delta = down ? -120 : 120;
            var wParam = new UIntPtr(unchecked((ulong)(uint)(delta << 16)));
            if (!NativeMethods.PostMessage(target, WM_MOUSEWHEEL, wParam, lParam))
            {
                error = "The target window rejected a queued wheel message";
                return false;
            }
        }
        error = string.Empty;
        return true;
    }

    public static bool KeyWindowMessage(IntPtr rootWindow, ElementBounds? bounds, string chord, out string error)
    {
        if (!TryParseKeyChord(chord, out var keys, out error)) return false;
        var target = FocusedTarget(rootWindow);
        if (bounds is { } targetBounds && !targetBounds.IsEmpty)
        {
            var point = Center(targetBounds);
            target = DeepestWindowAt(rootWindow, point);
            if (target == IntPtr.Zero) target = rootWindow;
        }

        foreach (var key in keys)
        {
            if (!Send(target, WM_KEYDOWN, new UIntPtr((uint)key), IntPtr.Zero))
            {
                error = "The target window rejected or timed out while receiving key-down messages";
                return false;
            }
        }
        for (var index = keys.Count - 1; index >= 0; index--)
        {
            if (!Send(target, WM_KEYUP, new UIntPtr((uint)keys[index]), IntPtr.Zero))
            {
                error = "The target window rejected or timed out while receiving key-up messages";
                return false;
            }
        }
        error = string.Empty;
        return true;
    }

    public static bool TypeWindowMessage(IntPtr rootWindow, ElementBounds? bounds, string text, bool replace, out string error)
    {
        var target = FocusedTarget(rootWindow);
        if (bounds is { } targetBounds && !targetBounds.IsEmpty)
        {
            var point = Center(targetBounds);
            target = DeepestWindowAt(rootWindow, point);
            if (target == IntPtr.Zero) target = FocusedTarget(rootWindow);
        }
        if (replace)
        {
            if (!Send(target, WM_KEYDOWN, new UIntPtr(VK_CONTROL), IntPtr.Zero)
                || !Send(target, WM_KEYDOWN, new UIntPtr(VK_A), IntPtr.Zero)
                || !Send(target, WM_KEYUP, new UIntPtr(VK_A), IntPtr.Zero)
                || !Send(target, WM_KEYUP, new UIntPtr(VK_CONTROL), IntPtr.Zero))
            {
                error = "The target window rejected the select-all key sequence";
                return false;
            }
        }
        foreach (var character in text)
        {
            if (!Send(target, WM_CHAR, new UIntPtr(character), IntPtr.Zero))
            {
                error = "The target window rejected or timed out while receiving Unicode text messages";
                return false;
            }
        }
        error = string.Empty;
        return true;
    }

    public static bool ClickForeground(ElementEntry entry, out string error)
    {
        return ClickForegroundAt(entry.RootWindow, Center(entry.Bounds), 1, out error);
    }

    public static bool ClickForegroundAt(IntPtr rootWindow, PointInt point, int clicks, out string error)
    {
        NativeMethods.GetCursorPos(out var old);
        ActivateWindow(rootWindow);
        if (!NativeMethods.SetCursorPos(point.X, point.Y))
        {
            error = "SetCursorPos failed";
            return false;
        }
        var inputs = Enumerable.Range(0, clicks)
            .SelectMany(_ => new[] { Input.Mouse(0x0002), Input.Mouse(0x0004) })
            .ToArray();
        var sent = NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
        NativeMethods.SetCursorPos(old.X, old.Y);
        error = sent == inputs.Length ? string.Empty : "SendInput was blocked (possibly by UIPI)";
        return sent == inputs.Length;
    }

    public static bool SetTextForeground(ElementEntry entry, string text, out string error)
    {
        if (!ClickForeground(entry, out error)) return false;
        var inputs = new List<Input>
        {
            Input.Key(VK_CONTROL, false), Input.Key(VK_A, false), Input.Key(VK_A, true), Input.Key(VK_CONTROL, true),
        };
        foreach (var character in text)
        {
            inputs.Add(Input.Unicode(character, false));
            inputs.Add(Input.Unicode(character, true));
        }
        var array = inputs.ToArray();
        var sent = NativeMethods.SendInput((uint)array.Length, array, Marshal.SizeOf<Input>());
        error = sent == array.Length ? string.Empty : "SendInput was blocked (possibly by UIPI)";
        return sent == array.Length;
    }

    public static bool ScrollForeground(ElementEntry entry, bool down, int steps, out string error)
    {
        var point = Center(entry.Bounds);
        NativeMethods.GetCursorPos(out var old);
        ActivateWindow(entry.RootWindow);
        NativeMethods.SetCursorPos(point.X, point.Y);
        var input = Input.Mouse(0x0800, (uint)unchecked((down ? -120 : 120) * steps));
        var sent = NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf<Input>());
        NativeMethods.SetCursorPos(old.X, old.Y);
        error = sent == 1 ? string.Empty : "SendInput was blocked (possibly by UIPI)";
        return sent == 1;
    }

    public static bool KeyForeground(IntPtr rootWindow, string chord, out string error)
    {
        if (!TryParseKeyChord(chord, out var keys, out error)) return false;
        ActivateWindow(rootWindow);
        var inputs = new List<Input>();
        foreach (var key in keys) inputs.Add(Input.Key(key, false));
        for (var index = keys.Count - 1; index >= 0; index--) inputs.Add(Input.Key(keys[index], true));
        var array = inputs.ToArray();
        var sent = NativeMethods.SendInput((uint)array.Length, array, Marshal.SizeOf<Input>());
        error = sent == array.Length ? string.Empty : "SendInput was blocked (possibly by UIPI)";
        return sent == array.Length;
    }

    public static bool TypeForeground(IntPtr rootWindow, string text, bool replace, out string error)
    {
        ActivateWindow(rootWindow);
        var inputs = new List<Input>();
        if (replace)
        {
            inputs.Add(Input.Key(VK_CONTROL, false));
            inputs.Add(Input.Key(VK_A, false));
            inputs.Add(Input.Key(VK_A, true));
            inputs.Add(Input.Key(VK_CONTROL, true));
        }
        foreach (var character in text)
        {
            inputs.Add(Input.Unicode(character, false));
            inputs.Add(Input.Unicode(character, true));
        }
        var array = inputs.ToArray();
        if (array.Length == 0) { error = string.Empty; return true; }
        var sent = NativeMethods.SendInput((uint)array.Length, array, Marshal.SizeOf<Input>());
        error = sent == array.Length ? string.Empty : "SendInput was blocked (possibly by UIPI)";
        return sent == array.Length;
    }

    private static bool TryParseKeyChord(string chord, out List<int> keys, out string error)
    {
        keys = new List<int>();
        var parts = chord.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
        {
            error = "Key chord must contain at least one key";
            return false;
        }
        foreach (var part in parts)
        {
            if (!TryParseVirtualKey(part, out var key))
            {
                error = $"Unsupported key '{part}'. Use names such as Enter, Escape, Tab, Space, Delete, arrows, F1-F24, A-Z, 0-9, Ctrl, Shift, Alt, Numpad0, or VK:0xNN.";
                return false;
            }
            if (keys.Contains(key))
            {
                error = $"Key chord '{chord}' repeats '{part}'.";
                return false;
            }
            keys.Add(key);
        }
        error = string.Empty;
        return true;
    }

    private static bool TryParseVirtualKey(string value, out int key)
    {
        var normalized = value.Trim().Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        var named = normalized switch
        {
            "ENTER" or "RETURN" => 0x0D,
            "ESC" or "ESCAPE" => 0x1B,
            "TAB" => 0x09,
            "SPACE" or "SPACEBAR" => 0x20,
            "BACKSPACE" or "BACK" => 0x08,
            "DELETE" or "DEL" => 0x2E,
            "INSERT" or "INS" => 0x2D,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" or "PGUP" => 0x21,
            "PAGEDOWN" or "PGDN" => 0x22,
            "UP" or "ARROWUP" => 0x26,
            "DOWN" or "ARROWDOWN" => 0x28,
            "LEFT" or "ARROWLEFT" => 0x25,
            "RIGHT" or "ARROWRIGHT" => 0x27,
            "CTRL" or "CONTROL" => 0x11,
            "SHIFT" => 0x10,
            "ALT" or "MENU" => 0x12,
            "WIN" or "WINDOWS" or "META" => 0x5B,
            "CAPSLOCK" => 0x14,
            "NUMLOCK" => 0x90,
            "SCROLLLOCK" => 0x91,
            "PAUSE" => 0x13,
            "PRINTSCREEN" or "PRTSC" => 0x2C,
            "APPS" or "CONTEXTMENU" => 0x5D,
            "PLUS" => 0xBB,
            "MINUS" => 0xBD,
            "COMMA" => 0xBC,
            "PERIOD" or "DOT" => 0xBE,
            "SLASH" => 0xBF,
            "SEMICOLON" => 0xBA,
            "QUOTE" or "APOSTROPHE" => 0xDE,
            "LBRACKET" => 0xDB,
            "RBRACKET" => 0xDD,
            "BACKSLASH" => 0xDC,
            "BACKTICK" or "GRAVE" => 0xC0,
            "NUMPAD0" => 0x60,
            "NUMPAD1" => 0x61,
            "NUMPAD2" => 0x62,
            "NUMPAD3" => 0x63,
            "NUMPAD4" => 0x64,
            "NUMPAD5" => 0x65,
            "NUMPAD6" => 0x66,
            "NUMPAD7" => 0x67,
            "NUMPAD8" => 0x68,
            "NUMPAD9" => 0x69,
            "MULTIPLY" => 0x6A,
            "ADD" => 0x6B,
            "SUBTRACT" => 0x6D,
            "DECIMAL" => 0x6E,
            "DIVIDE" => 0x6F,
            "VOLUMEUP" => 0xAF,
            "VOLUMEDOWN" => 0xAE,
            "VOLUMEMUTE" => 0xAD,
            _ => 0,
        };
        if (named != 0) { key = named; return true; }
        var raw = normalized.StartsWith("VK:", StringComparison.Ordinal) ? normalized[3..]
            : normalized.StartsWith("VK_", StringComparison.Ordinal) ? normalized[3..]
            : null;
        if (raw is not null && int.TryParse(raw.StartsWith("0X", StringComparison.Ordinal) ? raw[2..] : raw,
            raw.StartsWith("0X", StringComparison.Ordinal) ? NumberStyles.AllowHexSpecifier : NumberStyles.Integer,
            CultureInfo.InvariantCulture, out var rawKey) && rawKey is > 0 and <= 0xFF)
        {
            key = rawKey;
            return true;
        }
        if (normalized.Length == 1 && normalized[0] is >= 'A' and <= 'Z') { key = normalized[0]; return true; }
        if (normalized.Length == 1 && normalized[0] is >= '0' and <= '9') { key = normalized[0]; return true; }
        if (normalized.Length is 2 or 3 && normalized.StartsWith('F') && int.TryParse(normalized[1..], out var f) && f is >= 1 and <= 24)
        {
            key = 0x70 + f - 1;
            return true;
        }
        key = 0;
        return false;
    }

    private static bool Send(IntPtr handle, uint message, UIntPtr wParam, IntPtr lParam)
        => NativeMethods.SendMessageTimeout(handle, message, wParam, lParam, 0x0002, 150, out _) != IntPtr.Zero;

    private static bool SendText(IntPtr handle, uint message, string text)
    {
        var pointer = Marshal.StringToHGlobalUni(text);
        try { return Send(handle, message, UIntPtr.Zero, pointer); }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static IntPtr DeepestWindowAt(IntPtr root, PointInt screenPoint)
    {
        var current = root;
        for (var depth = 0; depth < 12; depth++)
        {
            var client = screenPoint;
            if (!NativeMethods.ScreenToClient(current, ref client)) break;
            var child = NativeMethods.ChildWindowFromPointEx(current, client, 0x0001 | 0x0002 | 0x0004);
            if (child == IntPtr.Zero || child == current) break;
            current = child;
        }
        return current;
    }

    private static IntPtr FocusedTarget(IntPtr rootWindow)
    {
        var threadId = NativeMethods.GetWindowThreadProcessId(rootWindow, out _);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (threadId != 0 && NativeMethods.GetGUIThreadInfo(threadId, ref info)
            && info.Focus != IntPtr.Zero && (info.Focus == rootWindow || NativeMethods.IsChild(rootWindow, info.Focus)))
            return info.Focus;
        return rootWindow;
    }

    private static PointInt Center(ElementBounds rect)
        => rect.IsEmpty
            ? new PointInt(0, 0)
            : new PointInt((int)Math.Round(rect.X + rect.Width / 2), (int)Math.Round(rect.Y + rect.Height / 2));
    private static IntPtr MakeLParam(int low, int high) => new(unchecked((high << 16) | (low & 0xffff)));
}

internal static class NativeMethods
{
    internal delegate bool EnumWindowsProc(IntPtr handle, IntPtr lParam);

    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowTextLength(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll")] internal static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr handle, out RectInt rect);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] internal static extern bool ScreenToClient(IntPtr handle, ref PointInt point);
    [DllImport("user32.dll")] internal static extern IntPtr ChildWindowFromPointEx(IntPtr parent, PointInt point, uint flags);
    [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool PostMessage(IntPtr handle, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool BringWindowToTop(IntPtr handle);
    [DllImport("user32.dll")] internal static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachState);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(IntPtr handle, IntPtr deviceContext, uint flags);
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out PointInt point);
    [DllImport("user32.dll")] internal static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
}

[StructLayout(LayoutKind.Sequential)] internal struct RectInt
{
    public int Left, Top, Right, Bottom;
    public int Width => Math.Max(0, Right - Left);
    public int Height => Math.Max(0, Bottom - Top);
}

[StructLayout(LayoutKind.Sequential)] internal struct PointInt
{
    public int X, Y;
    public PointInt(int x, int y) { X = x; Y = y; }
}

[StructLayout(LayoutKind.Sequential)] internal struct GuiThreadInfo
{
    public uint Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public RectInt CaretRect;
}

[StructLayout(LayoutKind.Sequential)] internal struct Input
{
    public uint Type;
    public InputUnion Union;
    public static Input Mouse(uint flags, uint data = 0) => new() { Type = 0, Union = new InputUnion { Mouse = new MouseInput { Flags = flags, MouseData = data } } };
    public static Input Key(int key, bool up) => new() { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = (ushort)key, Flags = up ? 0x0002u : 0u } } };
    public static Input Unicode(char character, bool up) => new() { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { ScanCode = character, Flags = 0x0004u | (up ? 0x0002u : 0u) } } };
}

[StructLayout(LayoutKind.Explicit)] internal struct InputUnion
{
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyboardInput Keyboard;
}

[StructLayout(LayoutKind.Sequential)] internal struct MouseInput
{
    public int X, Y;
    public uint MouseData, Flags, Time;
    public UIntPtr ExtraInfo;
}

[StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput
{
    public ushort VirtualKey, ScanCode;
    public uint Flags, Time;
    public UIntPtr ExtraInfo;
}

internal sealed record WindowInfo(IntPtr Handle, int ProcessId, string Title, string ProcessName, string? ExecutablePath, string ClassName, bool Visible, bool Minimized, bool Cloaked, RectInt Rect, IntPtr OwnerHandle, int ZOrder, bool Foreground);
internal sealed record CachedProcessMetadata(string ProcessName, string? ExecutablePath, DateTimeOffset CapturedAt);
internal sealed record WindowDto(string Handle, string? OwnerHandle, int ZOrder, bool Foreground, int Pid, string Title, string ProcessName, string? ExecutablePath, string ClassName, bool Visible, bool Minimized, bool Cloaked, BoundsDto Bounds)
{
    public static WindowDto From(WindowInfo value) => new($"0x{value.Handle.ToInt64():X}", value.OwnerHandle == IntPtr.Zero ? null : $"0x{value.OwnerHandle.ToInt64():X}", value.ZOrder, value.Foreground, value.ProcessId, value.Title, value.ProcessName,
        value.ExecutablePath, value.ClassName, value.Visible, value.Minimized, value.Cloaked,
        new BoundsDto(value.Rect.Left, value.Rect.Top, value.Rect.Width, value.Rect.Height));
}
internal sealed record BoundsDto(int X, int Y, int Width, int Height);
internal sealed record AppCandidate(string Name, string? AppId, string? LaunchTarget, WindowInfo? Window, IEnumerable<string> Aliases);
internal sealed record ScoredCandidate(AppCandidate Candidate, double Score);
internal sealed record SnapshotOptions(bool InteractiveOnly, bool VisibleOnly, bool RawView, int MaxDepth, int MaxElements, string VisualFallback);
internal readonly record struct ElementBounds(double X, double Y, double Width, double Height)
{
    public bool IsEmpty => Width <= 0 || Height <= 0;
}
internal sealed record SnapshotNode(string Id, string? ParentId, int Depth, int Order, ElementBounds Bounds, string Formatted, string Signature);
internal sealed record SnapshotState(int ProcessId, IntPtr RootWindow, string Formatted, IReadOnlyList<SnapshotNode> Nodes, IReadOnlyList<ElementEntry> ElementEntries, IReadOnlyList<VisualEntry> VisualEntries);
internal sealed record ElementEntry(string Id, int ProcessId, IntPtr RootWindow, IUIAutomationElement Element, string? ParentId, ElementBounds Bounds, bool HasKeyboardFocus);
internal sealed record VisualEntry(string Id, int ProcessId, IntPtr RootWindow, string Text, ElementBounds Bounds, double Confidence);
internal sealed record VisualResult(IReadOnlyList<VisualEntry> Entries, string Status);
internal sealed record ActionResult(bool Success, string ElementId, int Pid, string Strategy, bool BackgroundSafe, string? Warning, bool EffectVerified = false)
{
    public static ActionResult Ok(ElementEntry entry, string strategy, bool backgroundSafe, string? warning = null)
        => new(true, entry.Id, entry.ProcessId, strategy, backgroundSafe, warning);
}
