// Copyright 2017 The go-ethereum Authors
// This file is part of go-ethereum.
//
// go-ethereum is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// go-ethereum is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with go-ethereum. If not, see <http://www.gnu.org/licenses/>.

package main

import (
	"crypto/ecdsa"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/Onther-Tech/plasma-evm/cmd/utils"
	"github.com/Onther-Tech/plasma-evm/crypto"
	"github.com/Onther-Tech/plasma-evm/log"
)

// deployBootnode queries the user for various input on deploying an bootnode
func (w *wizard) deployBootnode() {
	// Select the server to interact with
	server := w.selectServer()
	if server == "" {
		return
	}
	client := w.servers[server]

	// Generate random key
	var nodeKeyHex *ecdsa.PrivateKey
	var err error

	nodeKeyHex, err = crypto.GenerateKey()
	if err != nil {
		utils.Fatalf("could not generate key: %v", err)
	}

	infos := &bootnodeInfos{
		host:    client.server,
		port:    30301,
		nodekey: hex.EncodeToString(crypto.FromECDSA(nodeKeyHex)),
	}

	// Figure out which port to listen on
	fmt.Println()
	fmt.Printf("Which port should bootnode listen on? (default = %d)\n", infos.port)
	infos.port = w.readDefaultInt(infos.port)

	// Figure out which node key use
	fmt.Println()
	fmt.Printf("Which key should bootnode use for generate enode address? (empty, random)\n")
	infos.nodekey = w.readDefaultString(infos.nodekey)

	nodeKeyHex, err = crypto.HexToECDSA(infos.nodekey)
	if err != nil {
		utils.Fatalf("could not generate key: %v", err)
	}

	infos.enode = "enode://" + hex.EncodeToString(crypto.FromECDSAPub(&nodeKeyHex.PublicKey)[1:])
	infos.enode = infos.enode + "@" + infos.host + ":" + strconv.Itoa(infos.port)

	// Try to deploy the bootnode server on the host
	nocache := false
	if out, err := deployBootnode(client, w.images["bootnode"], w.network, infos, nocache); err != nil {
		log.Error("Failed to deploy bootnode container", "err", err)
		if len(out) > 0 {
			fmt.Printf("%s\n", out)
		}
		return
	}
	// All ok, run a network scan to pick any changes up
	w.networkStats()
}
