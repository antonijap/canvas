module github.com/getcanvas/canvas/cloud/tunnel

go 1.27.1

// tailcat v0.7.0, commit 546a07dc6b93df6ce42e36059f8a8b339061de7a (BSD-3-Clause). go.sum is made once with
// `go mod tidy` (it needs the network) and committed; builds then use -mod=readonly and fail on any mismatch.
require github.com/tailscale/tailcat v0.7.0
