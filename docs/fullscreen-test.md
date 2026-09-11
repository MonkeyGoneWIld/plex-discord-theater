# Native Activity fullscreen test

The player now has an Enter fullscreen button beside its display controls.
It requests native fullscreen on the player wrapper, retaining custom controls
and subtitles. This is a local display action available to hosts and viewers;
it does not send a playback or room synchronization command.

Discord controls whether the Activity can use the Fullscreen API. An unavailable
API or rejected request shows a dismissible message suggesting the Activity
pop-out. There is no CSS fullscreen fallback, so a failed request cannot be
mistaken for a successful native fullscreen transition.

## Discord layout limitation

The Activity runs inside an iframe owned by Discord. Discord's Activity iframe
does not grant the embedded page the browser `fullscreen` permission, so the
player's Fullscreen API request reports that fullscreen is unavailable in the
voice and text Activity views. The black space around the Activity is also part
of Discord's outer call layout; CSS in the Activity cannot extend outside its
iframe or remove that space.

To cover that outer space, use Discord's own **Full Screen** control in the
voice call toolbar (the control outside the Activity). Discord changes its
outer layout when that button is used. The Activity SDK exposes layout updates
to the app, but no supported command for an Activity to activate Discord's
outer fullscreen mode. Popping the Activity out and using the native fullscreen
control there is the other supported path.

## Live verification

Deploy the `feat/activity-native-fullscreen` branch using your normal deployment
process, then reload the Activity to pick up its new client bundle.

Repeat these checks in desktop voice Activity, desktop text Activity, and the
text Activity pop-out. If available, also compare Discord in a web browser.

1. Start playback and click Enter fullscreen in the player controls.
2. Record whether the view enters fullscreen, reports it is unavailable, or
   reports the request failed. On success, separately check whether Discord's
   outer bars disappear; a resolved API request alone does not prove that.
3. Verify subtitles, settings, and playback controls remain visible and usable.
4. Click Exit fullscreen, then enter again and press Esc. Check that the button
   returns to Enter fullscreen and the normal Activity layout is restored.
5. On a blocked request, dismiss the message and verify playback continues.
6. Repeat as a non-host viewer. Fullscreen should affect only that viewer.

Preserving the video's aspect ratio can still leave black bars inside the
player even when native fullscreen succeeds. Existing zoom modes control that
separately.

Build/type checks do not establish Discord compatibility. The live checks above
must be run in an authenticated, deployed Activity.
