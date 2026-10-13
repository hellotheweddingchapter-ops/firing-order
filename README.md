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

## How it reads the Tesla

The browser can't see the pedal, so everything comes from GPS speed:

- A Kalman filter estimates speed and acceleration at whatever rate the car delivers fixes.
- Throttle is worked out from acceleration plus road load. It is held steady at cruise and reacts in a few tenths of a second when you put your foot down.
- Lifting off (regen) becomes a closed-throttle overrun, judged on a slower reading so GPS noise can't flick it on and off. Below 7 km/h the clutch is open and the engine idles.
- Chill mode is scaled, so flooring it in Chill still sounds like full throttle.
- GPS dropouts (tunnels) hold speed until the signal returns.

**Drive modes:** Comfort upshifts early and cruises at 1,300-2,200 rpm with the exhaust valves shut. Sport holds gears, keeps the valves open and lets it pop.

**Test drive:** a scripted 90-second drive (town, lights, motorway on cruise control, overtake, slip road, roundabout) run through the same GPS path as the car.

**Car check (settings):** run it once in the car. It reports the GPS rate, whether fixes carry speed, motion sensors, what the steering-wheel scroll button sends, and audio output.

## Files

- `engine-worklet.js`: the synthesis (AudioWorklet; also runs in Node for offline renders)
- `engines.js`: per-engine firing order, exhaust layout, gear ratios, tuning values
- `drive-model.js`: Tesla model, GPS Kalman filter, load inference, test drive
- `app.js`: gearbox, ignition, UI, car check
