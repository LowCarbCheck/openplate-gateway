{
  description = "openplate-gateway development shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs = { self , nixpkgs ,... }: let
    supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    forAllSystems = f: nixpkgs.lib.genAttrs supportedSystems (system: f {
      pkgs = import nixpkgs { inherit system; };
    });
  in {
    devShells = forAllSystems ({ pkgs }: {
      default = pkgs.mkShell {
        # create an environment with nodejs_22 and pnpm
        packages = with pkgs; [
          nodejs_22
          nodePackages.pnpm
        ];

        shellHook = ''
          echo "node `${pkgs.nodejs}/bin/node --version`"
        '';
      };
    });
  };
}
