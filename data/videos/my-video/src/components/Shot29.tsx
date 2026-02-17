import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot29: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 8.28s total
	// Segments: 0-8s (Morph), 8-12s (Gavel) -> 8/12 = 2/3 ratio
	const splitFrame = Math.round((8 / 12) * durationInFrames);

	// Age Counter Animation (0 to 18)
	const age = Math.floor(
		interpolate(frame, [0, splitFrame], [0, 18], {
			extrapolateRight: 'clamp',
		})
	);

	// Morphing Effect (Simulate with scale and brightness)
	const morphProgress = interpolate(frame, [0, splitFrame], [0, 1], {
		extrapolateRight: 'clamp',
		easing: Easing.inOut(Easing.quad),
	});

	const scale = interpolate(morphProgress, [0, 1], [0.8, 1.1]);
	const brightness = interpolate(morphProgress, [0, 0.5, 1], [1, 1.5, 1]);

	// Gavel Transfer Animation (after splitFrame)
	const gavelProgress = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{extrapolateLeft: 'clamp', easing: Easing.out(Easing.quad)}
	);

	const gavelX = interpolate(gavelProgress, [0, 1], [-100, 0]);
	const gavelOpacity = interpolate(gavelProgress, [0, 0.2], [0, 1]);

	return (
		<AbsoluteFill style={{backgroundColor: '#0a0a0a'}}>
			{/* Main Image with Morphing Simulation */}
			<AbsoluteFill
				style={{
					transform: `scale(${scale})`,
					filter: `brightness(${brightness})`,
				}}
			>
				<Img
					src={staticFile('child_to_adult.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Age Counter */}
			<AbsoluteFill className="p-10">
				<div className="bg-black/50 w-40 h-40 rounded-full flex justify-center items-center border-4 border-white/30 backdrop-blur-sm">
					<span className="text-white text-7xl font-bold font-mono">
						{age}
					</span>
				</div>
			</AbsoluteFill>

			{/* Gavel Transfer Visual */}
			<AbsoluteFill 
				className="justify-center items-center"
				style={{opacity: gavelOpacity}}
			>
				<div 
					className="relative"
					style={{transform: `translateX(${gavelX}px)`}}
				>
					<div className="text-9xl transform -rotate-12">🔨</div>
					{/* Ownership text hint */}
					<div className="absolute -bottom-10 left-1/2 -translate-x-1/2 text-white font-bold text-2xl uppercase">
						Моё решение
					</div>
				</div>
			</AbsoluteFill>

			{/* Overlay Text */}
			{frame >= splitFrame && (
				<AbsoluteFill className="justify-end items-center pb-20">
					<div 
						className="bg-white/90 px-8 py-4 rounded-xl shadow-2xl"
						style={{
							opacity: interpolate(frame, [splitFrame, splitFrame + 15], [0, 1]),
							transform: `translateY(${interpolate(frame, [splitFrame, splitFrame + 15], [20, 0])}px)`
						}}
					>
						<h2 
							className="text-black text-4xl font-black uppercase tracking-tighter text-center"
							style={{fontFamily: 'Inter, sans-serif'}}
						>
							восемнадцать лет = самостоятельность
						</h2>
					</div>
				</AbsoluteFill>
			)}

			<Audio src={staticFile('shot29_voice.mp3')} />
		</AbsoluteFill>
	);
};
