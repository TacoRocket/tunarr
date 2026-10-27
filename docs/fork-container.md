# Fork container

The combined image includes our Tunarr source and matching FFmpeg/libplacebo runtime. Linux x86-64 is the initial target. Version `2026.10.4-fork.1` is [publicly available](https://github.com/TacoRocket/tunarr/pkgs/container/tunarr), and a complete pull with an empty Docker credentials configuration succeeded.

## Hardware and picture options

The basic Compose example starts without GPU access. On a Linux host with a VAAPI device, add this to the `tunarr` service, then select VAAPI and the appropriate render device in Tunarr's transcode profile:

```yaml
devices:
  - /dev/dri:/dev/dri
```

The image includes the optional filters, but does not enable hardware-specific trials globally. Add only the options you want to the service's existing `environment` list:

```yaml
# Optional driver-default scaling instead of the usual HQ scaling request.
- TUNARR_VAAPI_DEFAULT_SCALING=1

# Optional direct NV12 output for eligible Broadcast shader paths.
# This Native mode has only been validated with Intel ANV.
- TUNARR_CRT_DIRECT_NV12=1
- ETV_VAAPI_DIRECT_NV12=1
- TUNARR_CRT_NV12_OUTPUT=native

# Optional fixed-Hable VAAPI HDR conversion; leave unset to retain OpenCL.
- TUNARR_VAAPI_HABLE_LUT=1
```

Direct output does not remove shader work: shaders still use the programmable GPU, and encoding can use the dedicated video encoder. It avoids an intermediate conversion on eligible paths. Native mode is not a general cross-driver default. The fixed-Hable option handles eligible HDR10 material, lacks OpenCL's scene adaptation, and is not an exact picture match. Only Intel Gen12 has been exercised for that option. Unsupported hardware may fail; remove the corresponding option to restore the previous route.

Picture styles are channel settings, separate from these runtime options. See the source documentation for [picture controls](https://github.com/TacoRocket/tunarr/blob/45bd053639554757263200dbc5506cabf28182e7/server/src/ffmpeg/builder/filter/crt/README.md) and [scaling and HDR limits](https://github.com/TacoRocket/tunarr/blob/45bd053639554757263200dbc5506cabf28182e7/docs/configure/ffmpeg/transcode_config.md). Ad pods currently use the [random-slot API](https://github.com/TacoRocket/tunarr/blob/45bd053639554757263200dbc5506cabf28182e7/docs/configure/scheduling/random-slots.md#after-show-pod-configuration-through-the-api).

## Publication status

[The successful run](https://github.com/TacoRocket/tunarr/actions/runs/40460893717) built both components, passed the optional-filter and fresh-config checks, and published the application. An anonymous Linux amd64 pull returned the same digest as the publication log:

```text
ghcr.io/tacorocket/tunarr@sha256:6b9fbe9e16230a4eb207e7dcdd646ae24418a2b9b745cec24005dff3fcd0574b
```

The publication recipe is commit `b0fd00ad4f8ffd9495b99b5dd7fab121d554b701`. [Attempt 1](https://github.com/TacoRocket/tunarr/actions/runs/40459059909) built both images but stopped before the application push when its readiness check did not retry a startup connection reset. The corrected check retried the resets and passed once the server was listening. No application code or source inputs changed between attempts.

## What this first release proves

The application and FFmpeg source revisions come from our tested custom setup. This public image is assembled afresh from those public sources, without private configuration, media, or the deployment's local compatibility wrapper. It is not a copy of a running installation. The workflow checks FFmpeg's software encode/probe capabilities, optional filter presence, and Tunarr startup with an empty configuration before publishing the application image. Hosted runners do not establish GPU playback or IPTV-client acceptance for this new assembly.

Keep versioned images and a matching configuration backup for rollback. Reverting an image alone does not undo database migrations. This first release does not publish a moving `latest` tag or deploy anything automatically.

## Source and maintenance

- Tunarr: [`45bd053`](https://github.com/TacoRocket/tunarr/commit/45bd053639554757263200dbc5506cabf28182e7), based on upstream 2026.10.4 with our integrated changes.
- FFmpeg build and patches: [`fd620cfb`](https://github.com/TacoRocket/ErsatzTV-ffmpeg/commit/fd620cfbc1c635690ecc17f443fd1bd622f0123f), using FFmpeg 8.1.2 and the dependency image pinned in that revision.
- [Release inputs](../docker/fork-release.json) identify the two source revisions and image version. `main` contains the latest reviewed, integrated fork source; the release inputs continue to identify the exact source used for the published image.

The manual [publication workflow](../.github/workflows/build-and-push-docker.yml) builds the optional NV12 and VAAPI LUT components through the existing FFmpeg recipe, then uses that runtime's registry digest as the Tunarr base. It publishes only to this fork's GitHub container registry. New source combinations get new version tags after review. Reuse the existing recipes; avoid another independent build system.

For a new package, check its visibility in GitHub Packages and verify a complete pull without credentials before advertising it as available. The first `tunarr` package is public and passed that check. Users only need the combined `tunarr` image; the workflow manages the `tunarr-ffmpeg` intermediate.

Upstream improvements should replace our equivalent patches when adopted. Feature branches remain development checkpoints, not separate supported distributions. Use the [publication PR](https://github.com/TacoRocket/tunarr/pull/25) for first-release feedback and pull requests for code contributions; broader upstream changes are discussed with the relevant maintainer first.

### Release cadence

We follow upstream Tunarr's stable releases rather than a separate calendar. For each update, we integrate the upstream release with our remaining fixes, check the combined build, and publish a versioned fork image. Fixes already adopted upstream are removed from our patch set.

Candidates use names such as `2026.10.4-fork.2-rc.1`. After build checks, copied-configuration checks and playback acceptance, the accepted source combination gets a stable version such as `2026.10.4-fork.2`. Each published version records its Tunarr and FFmpeg revisions; existing version tags are not reused for changed builds. An upstream release starts the update process, not an automatic deployment or a same-day release promise.

You can pull `main` for newer reviewed source between releases. Use a versioned container for a tested package. Public main history stays intact: upstream changes are merged through an integration PR, without force-rebasing the branch people already use. Publication remains a manual action through the existing workflow.
