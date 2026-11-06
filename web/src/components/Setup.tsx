import type { Snapshot } from "@core/types";

function line(value: string, ok: string, denied: string, waiting: string): string {
  if (value === "on" || value === "allowed") return ok;
  if (value === "denied") return denied;
  return waiting;
}

export function Setup({ snapshot }: { snapshot: Snapshot }) {
  const { status } = snapshot;

  if (status.sensor === "offline") {
    return (
      <div className="setup">
        <div className="setup-body">
          <h2 className="setup-title">The sensor isn't connected</h2>
          <p className="quiet">The console only shows what the sensor has heard. Start it from the project folder, then this page fills in on its own.</p>
          <p style={{ marginTop: 12 }}><code>bun run dev</code></p>
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <div className="setup-body">
        <h2 className="setup-title">Learning where you are</h2>
        <p className="quiet">Places are recognised from nearby Wi-Fi. The first one appears after two matching scans, about a minute after listening starts.</p>
        <ul className="setup-steps">
          <li>
            <b>Bluetooth</b>
            <span>{line(status.bluetooth, "Listening", "Denied. Allow palantiny sensor in System Settings, Privacy & Security, Bluetooth.", "Waiting for permission")}</span>
          </li>
          <li>
            <b>Wi-Fi names</b>
            <span>{line(status.location, "Readable", "Denied. Allow palantiny sensor in System Settings, Privacy & Security, Location Services.", "Waiting for Location permission")}</span>
          </li>
        </ul>
        <p className="quiet" style={{ marginTop: 16 }}>
          macOS asks once for each. If you don't see a prompt, open System Settings, Privacy &amp; Security, and allow palantiny sensor there.
        </p>
      </div>
    </div>
  );
}
