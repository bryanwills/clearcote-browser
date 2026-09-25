using System.Reflection;
using System.Text.Json;
using Microsoft.Playwright;
using Xunit;

namespace Clearcote.Tests;

// Humanize's DOM reads run in an isolated world, never the page's (mirrors the Python and Node tests).
public class IsolatedWorldTests
{
    public class FakeCdp : DispatchProxy
    {
        public List<(string Method, Dictionary<string, object>? Args)> Calls { get; } = new();
        public Queue<string> Values { get; } = new();   // JSON of each Runtime.evaluate result value
        public bool StaleOnce { get; set; }
        private int _nextCtx = 7;

        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method?.Name != "SendAsync") return Task.CompletedTask;
            var name = (string)args![0]!;
            var p = args.Length > 1 ? args[1] as Dictionary<string, object> : null;
            Calls.Add((name, p));
            string json = name switch
            {
                "Page.getFrameTree" => "{\"frameTree\":{\"frame\":{\"id\":\"MAIN\"}}}",
                "Page.createIsolatedWorld" => $"{{\"executionContextId\":{++_nextCtx}}}",
                "Runtime.evaluate" when StaleOnce => "STALE",
                "Runtime.evaluate" => $"{{\"result\":{{\"value\":{(Values.Count > 0 ? Values.Dequeue() : "null")}}}}}",
                _ => throw new InvalidOperationException(name),
            };
            if (json == "STALE")
            {
                StaleOnce = false;
                return Task.FromException<JsonElement?>(new PlaywrightException("Cannot find context with specified id"));
            }
            return Task.FromResult<JsonElement?>(JsonDocument.Parse(json).RootElement.Clone());
        }
    }

    public class FakeContext : DispatchProxy
    {
        public object? Cdp { get; set; }
        public int Sessions { get; private set; }
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method?.Name == "NewCDPSessionAsync")
            {
                Sessions++;
                return Cdp is null
                    ? Task.FromException<ICDPSession>(new PlaywrightException("no cdp"))
                    : Task.FromResult((ICDPSession)Cdp);
            }
            return null;
        }
    }

    public class FakePage : DispatchProxy
    {
        public object? Context { get; set; }
        protected override object? Invoke(MethodInfo? method, object?[]? args)
        {
            if (method?.Name == "get_Context") return Context;
            if (method?.Name?.StartsWith("Evaluate", StringComparison.Ordinal) == true)
                throw new InvalidOperationException("humanize must not evaluate in the page's world");
            return null;
        }
    }

    private static (IPage Page, FakeCdp Cdp, FakeContext Ctx) Make(bool withCdp = true)
    {
        var cdp = DispatchProxy.Create<ICDPSession, FakeCdp>();
        var ctx = DispatchProxy.Create<IBrowserContext, FakeContext>();
        var page = DispatchProxy.Create<IPage, FakePage>();
        ((FakeContext)(object)ctx).Cdp = withCdp ? cdp : null;
        ((FakePage)(object)page).Context = ctx;
        return (page, (FakeCdp)(object)cdp, (FakeContext)(object)ctx);
    }

    [Fact]
    public async Task Evaluates_in_an_isolated_world_of_the_main_frame()
    {
        var (page, cdp, _) = Make();
        cdp.Values.Enqueue("[1280,720]");
        var r = await IsolatedWorld.For(page).EvaluateAsync(IsolatedWorld.Viewport);
        Assert.Equal(1280, r!.Value[0].GetInt32());
        Assert.Equal(new[] { "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate" },
            cdp.Calls.Select(c => c.Method).ToArray());
        Assert.Equal("MAIN", cdp.Calls[1].Args!["frameId"]);
        var ev = cdp.Calls[2].Args!;
        Assert.Equal(8, ev["contextId"]);
        Assert.Equal(true, ev["returnByValue"]);
        Assert.Equal($"({IsolatedWorld.Viewport})(null)", ev["expression"]);
    }

    [Fact]
    public async Task Recreates_the_world_after_a_navigation()
    {
        var (page, cdp, _) = Make();
        cdp.StaleOnce = true;
        cdp.Values.Enqueue("[800,600]");
        var r = await IsolatedWorld.For(page).EvaluateAsync(IsolatedWorld.Viewport, "x");
        Assert.Equal(600, r!.Value[1].GetInt32());
        Assert.Equal(2, cdp.Calls.Count(c => c.Method == "Page.createIsolatedWorld"));
        Assert.Equal(9, cdp.Calls[^1].Args!["contextId"]);
        Assert.Equal($"({IsolatedWorld.Viewport})(\"x\")", cdp.Calls[^1].Args!["expression"]);
    }

    [Fact]
    public async Task Returns_null_instead_of_touching_the_page_world()
    {
        var (page, _, _) = Make(withCdp: false);
        Assert.Null(await IsolatedWorld.For(page).EvaluateAsync(IsolatedWorld.FocusedRect));
    }

    [Fact]
    public async Task One_world_and_one_cdp_session_per_page()
    {
        var (page, cdp, ctx) = Make();
        cdp.Values.Enqueue("1");
        cdp.Values.Enqueue("2");
        Assert.Same(IsolatedWorld.For(page), IsolatedWorld.For(page));
        await IsolatedWorld.For(page).EvaluateAsync(IsolatedWorld.Viewport);
        await IsolatedWorld.For(page).EvaluateAsync(IsolatedWorld.Viewport);
        Assert.Equal(1, ctx.Sessions);
    }
}
