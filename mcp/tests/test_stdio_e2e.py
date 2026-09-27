"""End to end over stdio, against whichever `mcp` release is installed: start the real entry point
(`python -m clearcote_mcp`) and drive it with an MCP client. 0.1.0 broke on every fresh install
when mcp 2.x removed `mcp.server.fastmcp`; this is the test that catches that class of break."""
import json
import os
import sys

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@pytest.mark.asyncio
async def test_stdio_server_lists_tools_and_answers_a_call():
    env = dict(os.environ, CLEARCOTE_MCP_PREWARM="0")   # no browser launch
    env.pop("CLEARCOTE_ALLOW_PRIVATE_EGRESS", None)
    params = StdioServerParameters(command=sys.executable, args=["-m", "clearcote_mcp"], env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            names = {t.name for t in (await session.list_tools()).tools}
            assert {"navigate", "read_page", "get_cdp_endpoint"} <= names
            # The SSRF guard refuses before a browser is needed, so this is a full tool round
            # trip (arguments in, structured error out) with no clearcote binary on the machine.
            res = await session.call_tool("navigate", {"url": "http://localhost/"})
            body = json.loads(res.content[0].text)
            assert body["status"] == "error" and "refused" in body["error"]
