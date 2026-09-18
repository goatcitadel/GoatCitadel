#include "cell_runtime_streams.hpp"
#include <algorithm>
#include <cstring>
#include <limits>

namespace goatcitadel::worker_cell {
namespace {
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned size) noexcept {
  for (unsigned index = 0; index < size; ++index) bytes[index] = static_cast<std::uint8_t>(value >> (index * 8));
}
std::uint64_t Integer(const std::uint8_t* bytes, unsigned size) noexcept {
  std::uint64_t value = 0; for (unsigned index = 0; index < size; ++index) value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8); return value;
}
bool Nonzero(const CellFileSha256& bytes) noexcept { return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; }); }
bool StreamKind(CellControllerMessage kind, CellRuntimeStream* stream, bool* eof) noexcept {
  switch (kind) {
    case CellControllerMessage::runtime_input: *stream = CellRuntimeStream::input; *eof = false; return true;
    case CellControllerMessage::runtime_input_end: *stream = CellRuntimeStream::input; *eof = true; return true;
    case CellControllerMessage::runtime_output: *stream = CellRuntimeStream::output; *eof = false; return true;
    case CellControllerMessage::runtime_output_end: *stream = CellRuntimeStream::output; *eof = true; return true;
    case CellControllerMessage::runtime_error: *stream = CellRuntimeStream::error; *eof = false; return true;
    case CellControllerMessage::runtime_error_end: *stream = CellRuntimeStream::error; *eof = true; return true;
    default: return false;
  }
}
}
bool EncodeCellRuntimeStream(const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame,
  CellControllerMessage* kind, CellRuntimeStreamBytes* output) noexcept {
  if (!kind || !output) return false;
  *kind = {}; *output = {};
  const auto stream = static_cast<unsigned>(frame.stream);
  if (stream > 2 || !Nonzero(binding.nonce) || !Nonzero(binding.request_sha256) || !frame.sequence ||
      frame.count > frame.data.size() || (frame.eof ? frame.count != 0 : frame.count == 0) ||
      frame.total < frame.count || frame.total > 64ULL * 1024 * 1024 ||
      std::any_of(frame.data.begin() + frame.count, frame.data.end(), [](auto byte) { return byte != 0; })) return false;
  constexpr std::array<CellControllerMessage, 3> data{CellControllerMessage::runtime_input, CellControllerMessage::runtime_output, CellControllerMessage::runtime_error};
  constexpr std::array<CellControllerMessage, 3> ends{CellControllerMessage::runtime_input_end, CellControllerMessage::runtime_output_end, CellControllerMessage::runtime_error_end};
  std::copy(binding.nonce.begin(), binding.nonce.end(), output->begin());
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), output->begin() + 32);
  Put(output->data() + 64, frame.sequence, 4); Put(output->data() + 68, frame.count, 4); Put(output->data() + 72, frame.total, 8);
  std::copy(frame.data.begin(), frame.data.end(), output->begin() + 80);
  *kind = frame.eof ? ends[stream] : data[stream]; return true;
}
bool DecodeCellRuntimeStream(const CellRuntimeDispatchBinding& expected, CellControllerMessage kind,
  const CellRuntimeStreamBytes& supplied, CellRuntimeStreamFrame* output) noexcept {
  if (!output) return false;
  const auto binding = expected; const auto bytes = supplied; *output = {};
  CellRuntimeStreamFrame frame;
  if (!StreamKind(kind, &frame.stream, &frame.eof) || !std::equal(binding.nonce.begin(), binding.nonce.end(), bytes.begin()) ||
      !std::equal(binding.request_sha256.begin(), binding.request_sha256.end(), bytes.begin() + 32)) return false;
  frame.sequence = static_cast<std::uint32_t>(Integer(bytes.data() + 64, 4));
  frame.count = static_cast<std::uint32_t>(Integer(bytes.data() + 68, 4)); frame.total = Integer(bytes.data() + 72, 8);
  std::copy_n(bytes.begin() + 80, frame.data.size(), frame.data.begin());
  CellControllerMessage encoded_kind{}; CellRuntimeStreamBytes canonical{};
  if (!EncodeCellRuntimeStream(binding, frame, &encoded_kind, &canonical) || encoded_kind != kind || canonical != bytes) return false;
  *output = frame; return true;
}
DWORD CellRuntimeStreamSequence::Accept(CellControllerMessage kind, const CellRuntimeStreamBytes& bytes, CellRuntimeStreamFrame* output) noexcept {
  if (!output) return failure_ = ERROR_INVALID_PARAMETER;
  *output = {};
  if (failure_) return failure_;
  CellRuntimeStreamFrame frame;
  if (input_limit_ > kMaximumCellJobInputBytes || !output_limit_ || output_limit_ > 64ULL * 1024 * 1024 ||
      !DecodeCellRuntimeStream(binding_, kind, bytes, &frame) || receiving_input_ != (frame.stream == CellRuntimeStream::input))
    return failure_ = ERROR_INVALID_DATA;
  const auto stream = static_cast<unsigned>(frame.stream);
  if (ended_[stream] || sequences_[stream] == std::numeric_limits<std::uint32_t>::max() || frame.sequence != sequences_[stream] + 1 ||
      frame.total != totals_[stream] + frame.count) return failure_ = ERROR_INVALID_DATA;
  if (frame.stream == CellRuntimeStream::input ? frame.total > input_limit_ :
      frame.total + totals_[stream == 1 ? 2 : 1] > output_limit_) return failure_ = ERROR_NOT_ENOUGH_QUOTA;
  sequences_[stream] = frame.sequence; totals_[stream] = frame.total; ended_[stream] = frame.eof;
  *output = frame; return ERROR_SUCCESS;
}
std::uint64_t CellRuntimeStreamSequence::Total(CellRuntimeStream stream) const noexcept {
  const auto index = static_cast<unsigned>(stream); return index < totals_.size() ? totals_[index] : 0;
}
DWORD CellRuntimeStreamBridge::StageInput(CellControllerMessage kind, const CellRuntimeStreamBytes& bytes) noexcept {
  if (failure_) return failure_;
  if (pending_) return failure_ = ERROR_INVALID_STATE;
  const auto error = input_.Accept(kind, bytes, &staged_);
  if (error) return failure_ = error;
  std::copy_n(bytes.begin(), acknowledgment_.size(), acknowledgment_.begin()); pending_ = true; return ERROR_SUCCESS;
}
DWORD CellRuntimeStreamBridge::FlushInput(JobStdioChannel& channel, std::array<std::uint8_t, 80>* acknowledgment) noexcept {
  if (!acknowledgment) return failure_ = ERROR_INVALID_PARAMETER;
  *acknowledgment = {};
  if (failure_) return failure_;
  if (!pending_) return ERROR_NO_MORE_ITEMS;
  const auto error = channel.WriteInput(staged_.count ? staged_.data.data() : nullptr, staged_.count, staged_.eof);
  if (error) { if (error != ERROR_RETRY) failure_ = error; return error; }
  *acknowledgment = acknowledgment_; acknowledgment_ = {}; staged_ = {}; pending_ = false;
  return ERROR_SUCCESS;
}
DWORD CellRuntimeStreamBridge::NextOutput(JobStdioChannel& channel, JobOutputStream stream,
  CellControllerMessage* kind, CellRuntimeStreamBytes* output) noexcept {
  if (!kind || !output) return failure_ = ERROR_INVALID_PARAMETER;
  *kind = {}; *output = {};
  if (failure_) return failure_;
  if (stream != JobOutputStream::standard_output && stream != JobOutputStream::standard_error) return failure_ = ERROR_INVALID_PARAMETER;
  const auto index = stream == JobOutputStream::standard_output ? 0u : 1u;
  if (output_ended_[index]) return ERROR_NO_MORE_ITEMS;
  CellRuntimeStreamFrame frame; frame.stream = index == 0 ? CellRuntimeStream::output : CellRuntimeStream::error;
  bool eof = false; DWORD count = 0;
  const auto error = channel.ReadOutput(stream, frame.data.data(), static_cast<DWORD>(frame.data.size()), &count, &eof);
  if (error) return failure_ = error;
  frame.count = count;
  if (!frame.count && !eof) return ERROR_NO_MORE_ITEMS;
  frame.eof = !frame.count && eof; frame.sequence = output_sequences_[index] + 1; frame.total = output_totals_[index] + frame.count;
  CellRuntimeStreamBytes bytes{}; CellControllerMessage encoded{}; CellRuntimeStreamFrame decoded;
  if (!EncodeCellRuntimeStream(binding_, frame, &encoded, &bytes)) return failure_ = ERROR_INVALID_DATA;
  const auto accepted = output_.Accept(encoded, bytes, &decoded);
  if (accepted) return failure_ = accepted;
  output_sequences_[index] = frame.sequence; output_totals_[index] = frame.total; output_ended_[index] = frame.eof;
  *kind = encoded; *output = bytes; return ERROR_SUCCESS;
}
DWORD ReadCellControllerRuntimeEvent(HANDLE pipe, bool from_worker, CellControllerMessage* kind,
  CellRuntimeStreamBytes* bytes, HANDLE stop, ULONGLONG deadline) noexcept {
  if (!kind || !bytes) return ERROR_INVALID_PARAMETER;
  *kind = {}; *bytes = {};
  std::array<std::uint8_t, 16> header{};
  auto error = ReadCellPipe(pipe, header.data(), static_cast<DWORD>(header.size()), stop, deadline);
  const auto received = static_cast<CellControllerMessage>(Integer(header.data() + 8, 4));
  const auto count = static_cast<DWORD>(Integer(header.data() + 12, 4));
  const bool stream = from_worker ? received == CellControllerMessage::runtime_input || received == CellControllerMessage::runtime_input_end :
    received == CellControllerMessage::runtime_output || received == CellControllerMessage::runtime_output_end ||
    received == CellControllerMessage::runtime_error || received == CellControllerMessage::runtime_error_end;
  const auto expected_count = stream ? 1056u : received == (from_worker ? CellControllerMessage::runtime_authorized : CellControllerMessage::runtime_authority) ? 104u :
    !from_worker && received == CellControllerMessage::runtime_input_ack ? 80u : 0u;
  if (!error && (std::memcmp(header.data(), "GCCELL01", 8) || !expected_count || count != expected_count)) error = ERROR_INVALID_DATA;
  if (!error) error = ReadCellPipe(pipe, bytes->data(), count, stop, deadline);
  if (error) { *bytes = {}; return error; }
  *kind = received; return ERROR_SUCCESS;
}
}
