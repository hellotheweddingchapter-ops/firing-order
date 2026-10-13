# Firing Order: engine sound prototype

Generated engine sound for an EV. No recordings: each cylinder firing is generated at its
crank angle, then shaped by its exhaust runner, the pipes and the muffler.

Engines: Porsche 911 GT3 (flat-six), Nissan GT-R (twin-turbo V6), Audi S3 (turbo four),
Ferrari 458 Italia (flat-plane V8). The names describe the simulated sound; there is no
affiliation with the manufacturers.

## Run it

```
python3 -m http.server 5178
```

Then open http://localhost:5178 and press **Start engine** (or Space).

- **Simulated drive:** hold ↑ / W for throttle (Shift for 40%), ↓ / S to brake, or use the on-screen pedals.
- **Feel it like the car will:** runs the simulator through the 9 Hz, noisy GPS path and works out throttle from acceleration, as the car has to.
- **Real GPS:** needs HTTPS on a phone or in the car. Location only works on https:// or localhost.
- **Manual:** E / Q, the scroll wheel, or the Tesla scroll button shifts.

- **Listen from:** driver's seat (body boom, damped highs, cabin reflections) or outside.
- **Reference recording:** load a recording of the real car; its spectrum shows in blue so you can match peaks.

`renders/` has 13-second offline renders of each engine, from the cabin and from outside
(idle, blip, full pull, overrun with crackles).

## Files

- `engine-worklet.js`: the synthesis (AudioWorklet; also runs in Node for offline renders)
- `engines.js`: per-engine firing order, exhaust layout, gear ratios, tuning values
- `app.js`: EV physics, GPS filtering, throttle inference, gearbox, UI
