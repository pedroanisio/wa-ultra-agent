// Command whatsapp-transport speaks the WhatsApp multi-device protocol and
// exposes it to the Node bridge over loopback HTTP.
//
// It replaces the Playwright/Chromium half of `whatsapp-bridge` — the session,
// the selectors and the DOM walking — and nothing else. The archive, the
// interaction twin, people and obligations all stay in `store.js`, which remains
// the only writer of the operator's correspondence.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/httpapi"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/sendguard"
	"github.com/pedroanisio/whatsapp-agent/whatsapp-transport/internal/session"
)

const (
	envDir      = "WA_TRANSPORT_DIR"
	envAddr     = "WA_TRANSPORT_ADDR"
	envLogLevel = "WA_TRANSPORT_LOG_LEVEL"
	envCapacity = "WA_TRANSPORT_OUTBOX_CAPACITY"

	// Loopback by default, and deliberately not `:8100`. This process can read
	// every message the account receives and send as the operator; binding it to
	// every interface by default would expose that to the network the moment
	// somebody ran it on a host with a public address.
	defaultAddr = "127.0.0.1:8100"

	shutdownGrace = 10 * time.Second
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("whatsapp-transport: %v", err)
	}
}

func run() error {
	dir := os.Getenv(envDir)
	if dir == "" {
		return fmt.Errorf("%s is required (it holds the paired session, which IS the "+
			"account credential — treat it as you would a private key)", envDir)
	}

	token := os.Getenv(httpapi.EnvToken)
	if token == "" {
		return fmt.Errorf("%s is required", httpapi.EnvToken)
	}

	capacity, err := capacityFromEnv()
	if err != nil {
		return err
	}

	// Root context cancelled on the first signal, so an in-flight QR stream and
	// the HTTP server wind down together rather than one outliving the other.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	wa, err := session.Open(ctx, session.Config{
		Dir:            dir,
		LogLevel:       session.LogLevel(os.Getenv(envLogLevel)),
		OutboxCapacity: capacity,
	})
	if err != nil {
		return err
	}
	defer wa.Close()

	guard, err := sendguard.New(ctx, os.Getenv, wa.Resolver())
	if err != nil {
		return err
	}

	api, err := httpapi.New(httpapi.Config{
		Token:    token,
		Session:  wa,
		Queue:    wa.Outbox(),
		Sender:   wa.Client(),
		Guard:    guard,
		Resolver: wa.Resolver(),
	})
	if err != nil {
		return err
	}

	addr := os.Getenv(envAddr)
	if addr == "" {
		addr = defaultAddr
	}

	// Connect an already-paired session at startup so that a restart resumes
	// receiving without anyone calling /connect. An unpaired one waits: pairing
	// needs a human with a phone, and there is nothing useful to do until then.
	if wa.Paired() {
		if err := wa.Connect(ctx); err != nil {
			// Not fatal. The HTTP surface is how an operator would diagnose and
			// retry, so exiting here would remove the only tool available.
			log.Printf("startup connect failed, serving anyway: %v", err)
		}
	} else {
		log.Printf("not paired — POST /pair/phone or open GET /pair/qr to link a device")
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: GET /pair/qr is a long-lived event stream, and a write
		// deadline would sever it mid-pairing.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	// Bind before announcing. `ListenAndServe` binds and serves in one call, so
	// logging first prints "listening on …" and only then discovers the port is
	// taken — which is precisely the moment the operator most needs the log to be
	// true. Splitting the two means the line is only written once it is a fact.
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("cannot listen on %s: %w\n"+
			"If another copy is already running, stop it or set %s to a free port. "+
			"Only one instance may hold the paired session in %s at a time.",
			addr, err, envAddr, dir)
	}
	log.Printf("listening on %s", listener.Addr())

	errs := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
			return
		}
		errs <- nil
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		log.Printf("shutting down")
	}

	// A fresh context: the root one is already cancelled, and Shutdown needs a
	// live deadline to drain in-flight requests rather than dropping them.
	grace, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	return server.Shutdown(grace)
}

func capacityFromEnv() (int64, error) {
	raw := os.Getenv(envCapacity)
	if raw == "" {
		return 0, nil // session.Open falls back to outbox.DefaultCapacity
	}
	capacity, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", envCapacity, err)
	}
	if capacity <= 0 {
		return 0, fmt.Errorf("%s must be positive; a capacity of %d would discard "+
			"every message on arrival", envCapacity, capacity)
	}
	return capacity, nil
}
