# Live-session replays

LiveKit recording is opt-in and independent of the live-shopping switch. When recording is configured, the API starts a LiveKit room-composite Egress job as the seller goes live and asks it to write an MP4 under a server-generated key in a private S3-compatible bucket. The server reconciles Egress completion every 15 seconds and makes the replay available to the seller only after the object is confirmed in storage.

Sellers can preview a ready replay privately, publish or unpublish it, or permanently delete an unpublished replay. A published replay appears in the public Live Shopping list after the live session ends. Unpublishing removes public access; deletion removes the stored file. Replays are retained until the seller deletes them, so storage costs continue for as long as a recording is retained. No recording jobs start until the storage gate is enabled.

In the Seller dashboard, draft or scheduled shows can be edited. A show must have a future scheduled time to be published; unpublishing returns it to drafts without removing its schedule. A seller must end an active broadcast before deleting it, and a show cannot be deleted while its replay is still processing. “Delete show” moves the record to the seller's Deleted shows archive, hides it from shoppers, and unpublishes its replay. It preserves show, attendance, and moderation history; sellers can restore it later. Replay files remain private in the archive until permanently deleted with the replay action.

## Configuration

1. Configure and verify the marketplace LiveKit provider as usual. The selected LiveKit deployment must support Egress and room-composite MP4 recording.
2. Create an S3-compatible bucket with public access blocked. Use a dedicated storage credential with only the access needed for LiveKit Egress to upload replay objects and for the application to read, inspect, and delete them. Configure the S3 provider's CORS only if required by its console; replay playback itself is proxied by the API and supports byte ranges.
3. Set these server-side variables in both the API process environment and deployment secret store:

```dotenv
LIVE_RECORDING_STORAGE_AVAILABLE=true
LIVE_RECORDING_STORAGE_BUCKET=your-private-bucket
LIVE_RECORDING_STORAGE_REGION=your-region
LIVE_RECORDING_STORAGE_ACCESS_KEY_ID=your-dedicated-access-key
LIVE_RECORDING_STORAGE_SECRET_ACCESS_KEY=your-dedicated-secret
LIVE_RECORDING_STORAGE_FORCE_PATH_STYLE=false
```

For a compatible provider that uses a non-AWS endpoint, also set `LIVE_RECORDING_STORAGE_ENDPOINT=https://your-provider-endpoint`. Omit it for AWS S3. Set `LIVE_RECORDING_STORAGE_FORCE_PATH_STYLE=true` only when that provider requires path-style bucket addressing. Never put these credentials in frontend variables or source control. Restart the API after changing them.

Live streaming remains available if the recording storage gate is off or an Egress job fails; that show is marked unrecorded/failed and no replay is published automatically. Publication always requires an explicit seller action after the recording reaches `READY`.
