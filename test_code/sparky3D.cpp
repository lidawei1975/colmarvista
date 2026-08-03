#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <bit>
#include <stdexcept>

// Structure representing metadata for one axis (dim = 0, 1, 2 for w1, w2, w3)
struct SparkyAxisHeader {
    std::string nucleus;        // Nucleus identifier (e.g. "1H", "13C", "15N")
    int32_t npoints;            // Total matrix points along this dimension
    int32_t block_size;         // Tile/Block size along this dimension
    float spectrometer_freq;    // Frequency in MHz (e.g. 600.13)
    float spectral_width;       // Sweep width in Hz
    float center_ppm;           // Center chemical shift in ppm
};

// Global File Header Structure
struct SparkyHeader {
    char ident[10];             // Should be "UCSF NMR\0\0"
    uint8_t naxis;              // Number of dimensions (3 for 3D)
    uint8_t ncomponents;        // 1 = Real, 2 = Complex (Real + Imaginary pairs)
    uint8_t encoding;           // Matrix encoding format
    uint8_t version;            // Format version (typically 2)
    std::vector<SparkyAxisHeader> axes;
};

class Sparky3DReader {
private:
    SparkyHeader header;
    std::vector<float> linear_real_data; // Stores ONLY real parts in (w1, w2, w3) order

    // Helper: Swap 32-bit big-endian to host endianness
    static uint32_t swap32(uint32_t val) {
        return ((val << 24) & 0xFF000000) |
               ((val << 8)  & 0x00FF0000) |
               ((val >> 8)  & 0x0000FF00) |
               ((val >> 24) & 0x000000FF);
    }

    static int32_t read_be_int32(std::istream& is) {
        uint32_t val;
        is.read(reinterpret_cast<char*>(&val), sizeof(val));
        if constexpr (std::endian::native == std::endian::little) {
            val = swap32(val);
        }
        return static_cast<int32_t>(val);
    }

    static float read_be_float(std::istream& is) {
        uint32_t val;
        is.read(reinterpret_cast<char*>(&val), sizeof(val));
        if constexpr (std::endian::native == std::endian::little) {
            val = swap32(val);
        }
        float f;
        std::memcpy(&f, &val, sizeof(f));
        return f;
    }

public:
    Sparky3DReader() = default;

    void open(const std::string& filename) {
        std::ifstream file(filename, std::ios::binary);
        if (!file.is_open()) {
            throw std::runtime_error("Unable to open UCSF file: " + filename);
        }

        // 1. Read 180-byte Main Header
        char header_buf[180];
        file.read(header_buf, 180);
        if (file.gcount() < 180) {
            throw std::runtime_error("Invalid file format: Header too short.");
        }

        std::memcpy(header.ident, header_buf, 10);
        if (std::string(header.ident, 8) != "UCSF NMR") {
            throw std::runtime_error("Not a valid UCSF Sparky file format.");
        }

        header.naxis       = static_cast<uint8_t>(header_buf[10]);
        header.ncomponents = static_cast<uint8_t>(header_buf[11]); // 1 = Real, 2 = Complex
        header.encoding    = static_cast<uint8_t>(header_buf[12]);
        header.version     = static_cast<uint8_t>(header_buf[13]);

        if (header.naxis != 3) {
            throw std::runtime_error("Expected a 3D dataset, but naxis = " + std::to_string(header.naxis));
        }

        if (header.ncomponents != 1 && header.ncomponents != 2) {
            throw std::runtime_error("Unsupported ncomponents value: " + std::to_string(header.ncomponents));
        }

        // 2. Read Axis Headers (128 bytes each)
        header.axes.resize(header.naxis);
        for (int i = 0; i < header.naxis; ++i) {
            std::streampos axis_pos = 180 + (i * 128);
            file.seekg(axis_pos);

            char nuc[7] = {0};
            file.read(nuc, 6);
            header.axes[i].nucleus = std::string(nuc);

            file.seekg(axis_pos + std::streamoff(8));
            header.axes[i].npoints     = read_be_int32(file);

            file.seekg(axis_pos + std::streamoff(16));
            header.axes[i].block_size  = read_be_int32(file);
            header.axes[i].spectrometer_freq = read_be_float(file);
            header.axes[i].spectral_width    = read_be_float(file);
            header.axes[i].center_ppm        = read_be_float(file);
        }

        // 3. Move file pointer to start of binary block data (180 + 3 * 128 = 564)
        file.seekg(180 + header.naxis * 128);

        // Grid dimensions and block tiling dimensions
        int32_t N1 = header.axes[0].npoints, B1 = header.axes[0].block_size;
        int32_t N2 = header.axes[1].npoints, B2 = header.axes[1].block_size;
        int32_t N3 = header.axes[2].npoints, B3 = header.axes[2].block_size;

        int32_t num_blocks_1 = (N1 + B1 - 1) / B1;
        int32_t num_blocks_2 = (N2 + B2 - 1) / B2;
        int32_t num_blocks_3 = (N3 + B3 - 1) / B3;

        int ncomp = header.ncomponents; // Stride multiplier (1 or 2)
        
        // Block volume accounts for real + imag values when ncomp == 2
        size_t float_count_per_block = static_cast<size_t>(B1) * B2 * B3 * ncomp;
        
        // Allocate space ONLY for real values in the output array
        linear_real_data.assign(static_cast<size_t>(N1) * N2 * N3, 0.0f);

        std::vector<float> block_buffer(float_count_per_block);

        // 4. Read tiled blocks, extract REAL values, ignore IMAGINARY values
        for (int b1 = 0; b1 < num_blocks_1; ++b1) {
            for (int b2 = 0; b2 < num_blocks_2; ++b2) {
                for (int b3 = 0; b3 < num_blocks_3; ++b3) {
                    
                    // Read one 3D tile (contains real/imag pairs if ncomp == 2)
                    for (size_t k = 0; k < float_count_per_block; ++k) {
                        block_buffer[k] = read_be_float(file);
                    }

                    // Map tile elements back into global matrix indices
                    for (int z = 0; z < B1; ++z) {
                        int w1 = b1 * B1 + z;
                        if (w1 >= N1) continue;

                        for (int y = 0; y < B2; ++y) {
                            int w2 = b2 * B2 + y;
                            if (w2 >= N2) continue;

                            for (int x = 0; x < B3; ++x) {
                                int w3 = b3 * B3 + x;
                                if (w3 >= N3) continue;

                                // If ncomp == 2, real part is at index (* 2), imag part is at (* 2 + 1).
                                // We strictly pull index (* ncomp) and drop the imaginary component.
                                size_t block_real_idx = ((static_cast<size_t>(z) * B2 + y) * B3 + x) * ncomp;
                                size_t global_real_idx = (static_cast<size_t>(w1) * N2 + w2) * N3 + w3;

                                linear_real_data[global_real_idx] = block_buffer[block_real_idx];
                            }
                        }
                    }

                }
            }
        }
    }

    // Direct flat array access to real data: data[w1][w2][w3]
    float operator()(int w1, int w2, int w3) const {
        size_t global_idx = (static_cast<size_t>(w1) * header.axes[1].npoints + w2) * header.axes[2].npoints + w3;
        return linear_real_data[global_idx];
    }

    // Convert spectral index (0 to N-1) to chemical shift in ppm
    float index_to_ppm(int axis_index, int pt) const {
        const auto& ax = header.axes.at(axis_index);
        float sw_ppm = ax.spectral_width / ax.spectrometer_freq;
        float first_point_ppm = ax.center_ppm + (sw_ppm / 2.0f);
        float step_ppm = sw_ppm / static_cast<float>(ax.npoints);
        return first_point_ppm - (pt * step_ppm);
    }

    const SparkyHeader& get_header() const { return header; }
    const std::vector<float>& get_real_data() const { return linear_real_data; }
};

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cout << "Usage: ./sparky3d_reader <path_to_3d_file.ucsf>\n";
        return 0;
    }

    try {
        Sparky3DReader reader;
        reader.open(argv[1]);

        const auto& hdr = reader.get_header();
        std::cout << "Successfully opened 3D Sparky Spectrum.\n";
        std::cout << "-------------------------------------\n";
        std::cout << "Format Mode: " << (hdr.ncomponents == 2 ? "Complex (Real + Imaginary)" : "Real Only") << "\n";
        std::cout << "Discarded Imaginary Component: " << (hdr.ncomponents == 2 ? "Yes" : "N/A") << "\n\n";

        for (int i = 0; i < 3; ++i) {
            std::cout << "Axis w" << (i + 1) << " (" << hdr.axes[i].nucleus << "): "
                      << hdr.axes[i].npoints << " pts, "
                      << "Tile: " << hdr.axes[i].block_size << " pts, "
                      << "Freq: " << hdr.axes[i].spectrometer_freq << " MHz, "
                      << "SW: " << hdr.axes[i].spectral_width << " Hz, "
                      << "Center: " << hdr.axes[i].center_ppm << " ppm\n";
        }

        // Query center point real value
        int mid1 = hdr.axes[0].npoints / 2;
        int mid2 = hdr.axes[1].npoints / 2;
        int mid3 = hdr.axes[2].npoints / 2;

        std::cout << "\nSample REAL intensity at center index (" << mid1 << ", " << mid2 << ", " << mid3 << "): "
                  << reader(mid1, mid2, mid3) << "\n";

        std::cout << "Center PPM positions: ("
                  << reader.index_to_ppm(0, mid1) << " ppm, "
                  << reader.index_to_ppm(1, mid2) << " ppm, "
                  << reader.index_to_ppm(2, mid3) << " ppm)\n";

    } catch (const std::exception& ex) {
        std::cerr << "Error: " << ex.what() << "\n";
        return 1;
    }

    return 0;
}