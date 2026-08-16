import { describe, expect, it, vi } from "vitest";

const registerAppResource = vi.fn();

vi.mock("@modelcontextprotocol/ext-apps/server", () => ({
  RESOURCE_MIME_TYPE: "text/html;profile=mcp-app",
  registerAppResource
}));

describe("registerReadingResource", () => {
  it("keeps current and legacy component URIs available with compatible CSP metadata", async () => {
    const {
      registerReadingCompatibilityProbeResource,
      registerReadingResource
    } = await import("./register-resource.js");
    const {
      READING_NEST_COMPATIBILITY_LEGACY_URIS,
      READING_NEST_LEGACY_URIS,
      READING_NEST_URI
    } = await import("./register-tools.js");

    const loadBootstrap = vi.fn().mockResolvedValue({
      sourceEndpointBase: "https://reading-nest.example.workers.dev/source/private",
      unsafeText: "</script><script>alert('no')</script>"
    });
    registerReadingResource(
      {} as never,
      "<html><head></head><body></body></html>",
      "https://reading-nest.example.workers.dev",
      loadBootstrap
    );
    registerReadingCompatibilityProbeResource({} as never);
    const [, , uri, descriptor, loader] = registerAppResource.mock.calls[0];
    const legacyCalls = registerAppResource.mock.calls.slice(
      1,
      1 + READING_NEST_LEGACY_URIS.length
    );
    const [, , legacyUri, , legacyLoader] = legacyCalls[0];
    const [, , probeUri, probeDescriptor, probeLoader] =
      registerAppResource.mock.calls[1 + READING_NEST_LEGACY_URIS.length];

    expect(READING_NEST_URI).toBe(
      "ui://ss-reading-nest/app-v82-native-inline.html"
    );
    expect(READING_NEST_LEGACY_URIS).toEqual(
      expect.arrayContaining([
        "ui://ss-reading-nest/app-v76-ios-remount.html",
        "ui://ss-reading-nest/app-v69-mobile-cover-recovery.html",
        "ui://ss-reading-nest/app-v68-pip-client-compat.html",
        "ui://ss-reading-nest/app-v67-stable-host-state.html",
        "ui://ss-reading-nest/app-v66-protected-bookshelf-bootstrap.html",
        "ui://ss-reading-nest/app-v65-mobile-bookshelf-fallback.html",
        "ui://ss-reading-nest/app-v64-official-resource-binding.html",
        "ui://ss-reading-nest/app-v62-mobile-ui-binding.html",
        "ui://ss-reading-nest/app-v52-gray-recovery.html",
        "ui://ss-reading-nest/app-v48.html",
        "ui://ss-reading-nest/app-v47.html",
        "ui://ss-reading-nest/reader-mobile-diagnose-v1.html"
      ])
    );
    expect(registerAppResource).toHaveBeenCalledTimes(
      1 + READING_NEST_LEGACY_URIS.length + 1 + READING_NEST_COMPATIBILITY_LEGACY_URIS.length
    );
    expect(uri).toBe("ui://ss-reading-nest/app-v82-native-inline.html");
    expect(legacyUri).toBe(READING_NEST_LEGACY_URIS[0]);
    expect(descriptor._meta.ui.csp.connectDomains).toContain(
      "https://reading-nest.example.workers.dev"
    );
    expect(descriptor._meta["openai/widgetCSP"].connect_domains).toContain(
      "https://reading-nest.example.workers.dev"
    );

    const loaded = await loader();
    expect(loaded.contents[0].uri).toBe(
      "ui://ss-reading-nest/app-v82-native-inline.html"
    );
    expect(loaded.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(loaded.contents[0]._meta.ui.csp.connectDomains).toContain(
      "https://reading-nest.example.workers.dev"
    );
    expect(loaded.contents[0]._meta["openai/widgetCSP"].connect_domains).toContain(
      "https://reading-nest.example.workers.dev"
    );
    expect(loaded.contents[0]._meta.ui.domain).toBeUndefined();
    expect(loaded.contents[0]._meta).not.toHaveProperty("openai/widgetDomain");
    expect(loadBootstrap).toHaveBeenCalledTimes(1);
    expect(loaded.contents[0].text).toContain("window.__SS_READING_NEST_BOOTSTRAP__=");
    expect(loaded.contents[0].text).toContain(
      '"sourceEndpointBase":"https://reading-nest.example.workers.dev/source/private"'
    );
    expect(loaded.contents[0].text).toContain("\\u003c/script>");
    expect(loaded.contents[0].text).not.toContain("</script><script>alert");

    const legacy = await legacyLoader();
    expect(legacy.contents[0].uri).toBe(READING_NEST_LEGACY_URIS[0]);
    for (const [legacyIndex, legacyCall] of legacyCalls.entries()) {
      const [, , registeredLegacyUri, , registeredLegacyLoader] = legacyCall;
      const loadedLegacy = await registeredLegacyLoader();
      expect(registeredLegacyUri).toBe(READING_NEST_LEGACY_URIS[legacyIndex]);
      expect(loadedLegacy.contents[0].uri).toBe(READING_NEST_LEGACY_URIS[legacyIndex]);
    }
    expect(probeUri).toBe("ui://ss-reading-nest/app-compat-v3.html");
    expect(probeDescriptor._meta.ui.prefersBorder).toBe(true);
    const probe = await probeLoader();
    expect(probe.contents[0].text).toContain("阿雾和陆沉的共读小巢 App 组件已显示");
    expect(probe.contents[0]._meta.ui.csp.connectDomains).toContain(
      "http://localhost:8787"
    );
    expect(probe.contents[0]._meta.ui.domain).toBeUndefined();
    expect(probe.contents[0]._meta).not.toHaveProperty("openai/widgetDomain");
  });
});
